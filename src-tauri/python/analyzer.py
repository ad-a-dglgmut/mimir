#!/usr/bin/env python3
import os
import io
import re
import json
import sys
import uuid
import tempfile
import pandas as pd
import numpy as np
from groq import Groq
import matplotlib

# Use Agg backend for any possible plotting in executed code (non-interactive)
matplotlib.use('Agg')


def check_file_type(file_path):
    ext = os.path.splitext(file_path)[1].lower()
    if ext == '.csv':
        return 'csv'
    elif ext in ['.xlsx', '.xls']:
        return 'excel'
    else:
        return 'unknown'


# =====================================================
# Data cleaning & normalization helpers
# =====================================================
def strip_nonprintable(s):
    if not isinstance(s, str):
        return s
    return re.sub(r'[^\x20-\x7E]', '', s).strip()


def normalize_dataframe(df: pd.DataFrame) -> pd.DataFrame:
    """
    Robust cleaning and lightweight type inference/coercion:
    - Strip whitespace and non-printables from string columns
    - Remove common currency symbols and thousands separators for numeric-like columns
    - Coerce numeric-looking columns to numeric (pd.to_numeric errors='coerce')
    """
    df = df.copy()

    # First, ensure column names are strings and sanitized (already done later, but safe)
    df.columns = [str(c).strip().lower().replace(" ", "_").replace("-", "_") if str(c).strip() != "" else f"col_{i}"
                  for i, c in enumerate(df.columns)]

    # Strip non-printable chars in all string cells
    for col in df.columns:
        # Convert bytes / non-string gracefully
        if df[col].dtype == object or df[col].dtype.name == 'string':
            df[col] = df[col].astype(str).apply(strip_nonprintable).replace({'nan': None, 'None': None})

    # Heuristic numeric coercion
    for col in df.columns:
        # sample non-null values
        sample = df[col].dropna().astype(str).head(100)
        if sample.empty:
            continue

        # Remove common currency/symbols and commas for testing
        cleaned = sample.str.replace(r'[\$\£\€\¥,]', '', regex=True).str.replace(r'\s+', '', regex=True)
        # Now test how many values look numeric
        looks_numeric = cleaned.str.match(r'^-?\d+(\.\d+)?$')
        numeric_ratio = float(looks_numeric.sum()) / float(len(cleaned))
        # If more than 50% look numeric, coerce entire column
        if numeric_ratio >= 0.5:
            coerced = pd.to_numeric(
                df[col].astype(str).str.replace(r'[^\d\.\-]', '', regex=True),
                errors='coerce'
            )
            df[col] = coerced

    return df


# =====================================================
# 1. CSV loader and cleaner
# =====================================================
def load_clean_csv(csv_path):
    print(f"Loading {csv_path}")
    print(f"Loading CSV from: {os.path.abspath(csv_path)}")

    encodings = ["utf-8-sig", "utf-8", "latin1", "windows-1252"]
    separators = [",", ";", "\t", "|"]

    df = None
    loaded = False

    for enc in encodings:
        for sep in separators:
            try:
                if check_file_type(csv_path) == 'csv':
                    df = pd.read_csv(
                        csv_path,
                        sep=sep,
                        encoding=enc,
                        engine="python",
                        on_bad_lines="skip"
                    )
                elif check_file_type(csv_path) == 'excel':
                    df = pd.read_excel(csv_path)

                if df is not None and df.shape[1] > 0 and df.shape[0] > 0:
                    print(f"Loaded successfully with sep='{sep}' encoding='{enc}' → {df.shape}")
                    loaded = True
                    break
            except Exception as e:
                print(f"Failed with encoding {enc}, separator {sep}: {e}")
                continue
        if loaded:
            break

    if not loaded or df is None:
        try:
            if check_file_type(csv_path) == 'csv':
                df = pd.read_csv(csv_path)
            elif check_file_type(csv_path) == 'excel':
                df = pd.read_excel(csv_path)
            print(f"Loaded with default parameters → {df.shape}")
        except Exception as e:
            raise ValueError(f"Could not parse file: {e}")

    # Clean headers
    df.columns = [
        str(c).strip().lower().replace(" ", "_").replace("-", "_")
        if str(c).strip() != "" else f"col_{i}"
        for i, c in enumerate(df.columns)
    ]

    # Strip non-printables and normalize strings
    for col in df.columns:
        if df[col].dtype == object or df[col].dtype.name == 'string':
            df[col] = df[col].astype(str).apply(strip_nonprintable).replace({
                "nan": None,
                "NaN": None,
                ".": None,
                "-": None,
                "--": None,
                "": None
            })

    df.dropna(axis=1, how="all", inplace=True)
    if df.shape[0] > 0:
        df.dropna(axis=0, thresh=max(1, int(df.shape[1] * 0.3)), inplace=True)

    # Normalize data types / coerce numeric-like columns
    df = normalize_dataframe(df)

    print("Cleaned columns:", list(df.columns))
    print("DataFrame shape:", df.shape)
    if df.shape[0] > 0:
        print(df.head(3).to_string())
    else:
        print("DataFrame is empty after cleaning")
    return df


# =====================================================
# 2. Initialize Groq Client
# =====================================================

def load_groq_client():
    api_key = os.getenv("GROQ_API_KEY")
    if not api_key:
        raise ValueError(
            "GROQ_API_KEY not found in environment variables.\n"
            "Set it in your environment (for example on Windows: setx GROQ_API_KEY \"your-key\")"
        )

    print("Connected to Groq API (client available)")
    return Groq(api_key=api_key)


# =====================================================
# 3. Call Groq API
# =====================================================

def call_groq(client, prompt, max_tokens=500, temperature=0.1, role="user"):
    """Call Groq API with automatic continuation and safe mode for summaries."""
    try:
        response = client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[{"role": "system",
                       "content": "You are a helpful, concise data analyst. "
                                  "Speak only in natural language unless code is requested."},
                      {"role": role, "content": prompt}],
            max_tokens=max_tokens,
            temperature=temperature
        )
        text = response.choices[0].message.content.strip()

        # If output seems incomplete, request a continuation
        if text.endswith("...") or len(text.split()) > 0.95 * max_tokens:
            continuation = client.chat.completions.create(
                model="llama-3.3-70b-versatile",
                messages=[{"role": "system",
                           "content": "Continue the previous response clearly in plain English."},
                          {"role": "assistant", "content": text}],
                max_tokens=int(max_tokens / 2),
                temperature=temperature
            )
            text += " " + continuation.choices[0].message.content.strip()

        return text
    except Exception as e:
        print(f"Groq API error: {e}")
        return None


# =====================================================
# 4. Extract clean Python code from LLM response
# =====================================================

def extract_code(text):
    """Extract only Python code from LLM response, removing explanations."""
    if not text:
        return ""

    # First try to find fenced python code blocks
    code_block_match = re.search(r'```(?:python)?\s*\n(.*?)\n```', text, re.DOTALL)
    if code_block_match:
        return code_block_match.group(1).strip()

    # Otherwise, try to extract obvious python lines
    lines = text.split('\n')
    code_lines = []
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith('#'):
            continue
        if any([
            stripped.startswith('import '),
            stripped.startswith('from '),
            'df.' in stripped or 'df[' in stripped,
            stripped.startswith('result ='),
            re.match(r'^[\w_]+\s*=', stripped)  # simple assignment
        ]):
            code_lines.append(line)
    return '\n'.join(code_lines).strip() or text


# =====================================================
# 7. Safe code execution with import fixes
# =====================================================

def safe_execute_code(code, df):
    """Safely execute pandas code with proper imports and error handling.
    Post-process the resulting `result` into JSON-able types where possible.
    """
    # Remove import statements (we already have pd, np available)
    code_clean = re.sub(r'^\s*(import|from)\s+.*$', '', code, flags=re.MULTILINE)

    # Add matplotlib stubs if user code references plt
    if 'plt.' in code_clean or 'matplotlib' in code_clean:
        code_clean = "import matplotlib\nmatplotlib.use('Agg')\nimport matplotlib.pyplot as plt\n" + code_clean

    # Limited builtins for safety
    safe_builtins = {
        'print': print,
        'len': len,
        'range': range,
        'list': list,
        'dict': dict,
        'str': str,
        'int': int,
        'float': float,
        'bool': bool,
        'type': type,
        'isinstance': isinstance,
        'zip': zip,
        'enumerate': enumerate,
        'min': min,
        'max': max,
        'sum': sum,
        'abs': abs,
        'round': round,
        '__import__': __import__,
    }

    # Execution environment
    local_env = {
        "pd": pd,
        "df": df,
        "np": np,
        "__builtins__": safe_builtins
    }

    try:
        exec(code_clean, local_env, local_env)
        raw_result = local_env.get("result", None)

        # Post-process common types to be safe & serializable
        processed_result = postprocess_result(raw_result)
        return processed_result, None
    except Exception as e:
        return None, str(e)


def postprocess_result(result):
    """Convert numpy arrays / object arrays / DataFrames / Series to friendly types."""
    # DataFrame -> keep as DataFrame (caller will handle). Ensure columns and dtypes are simple
    if isinstance(result, pd.DataFrame):
        # truncate very wide outputs; convert non-stringable columns safely
        return result

    if isinstance(result, pd.Series):
        return result

    # numpy array: try to convert to list
    if isinstance(result, np.ndarray):
        try:
            return result.tolist()
        except Exception:
            # fallback: coerce each element to str
            return [str(x) for x in result.flatten()]

    # If result is list/dict of pandas objects, convert inner pandas to pure types
    if isinstance(result, list):
        new_list = []
        for item in result:
            if isinstance(item, (pd.DataFrame, pd.Series)):
                new_list.append(item.to_dict(orient='records') if isinstance(item, pd.DataFrame) else item.tolist())
            elif isinstance(item, np.ndarray):
                try:
                    new_list.append(item.tolist())
                except Exception:
                    new_list.append(str(item))
            else:
                new_list.append(item)
        return new_list

    if isinstance(result, dict):
        new_dict = {}
        for k, v in result.items():
            if isinstance(v, (pd.DataFrame, pd.Series)):
                new_dict[k] = v.to_dict(orient='records') if isinstance(v, pd.DataFrame) else v.tolist()
            elif isinstance(v, np.ndarray):
                try:
                    new_dict[k] = v.tolist()
                except Exception:
                    new_dict[k] = str(v)
            else:
                new_dict[k] = v
        return new_dict

    # Primitive or anything else: return as-is
    return result


# =====================================================
# 8. Enhanced Chart Generation
# =====================================================

def _safe_as_number(x):
    try:
        if x is None:
            return None
        if isinstance(x, (int, float, np.integer, np.floating)):
            if pd.isna(x):
                return None
            return float(x)
        s = str(x).strip()
        s = re.sub(r'[^\d\.\-]', '', s)
        if s == '':
            return None
        return float(s)
    except Exception:
        return None


def generate_chart_json(user_query, result):
    """Generate ECharts compatible JSON based on analysis result"""
    if result is None:
        return None

    try:
        if isinstance(result, pd.DataFrame):
            return generate_dataframe_chart(result, user_query)
        elif isinstance(result, pd.Series):
            return generate_series_chart(result, user_query)
        elif isinstance(result, (list, dict)):
            return generate_basic_chart(result, user_query)
        else:
            return generate_simple_chart(str(result), user_query)
    except Exception as e:
        print(f"Chart generation error: {e}")
        return None


def generate_dataframe_chart(df, user_query):
    """Generate chart for DataFrame results"""
    if df.empty:
        return None

    # Convert index to simple list for labels
    df = df.copy()

    # Determine columns
    numeric_cols = df.select_dtypes(include=[np.number]).columns.tolist()
    categorical_cols = df.select_dtypes(include=['object', 'string']).columns.tolist()

    # Coerce first numeric column if present
    if not numeric_cols:
        # Try to coerce any column that looks numeric
        for col in df.columns:
            coerced = pd.to_numeric(df[col], errors='coerce')
            if coerced.notna().sum() > 0:
                numeric_cols.append(col)
                df[col] = coerced
                break

    # Small categorical bar: first categorical vs first numeric
    if len(df) <= 15 and categorical_cols and numeric_cols:
        category_col = categorical_cols[0]
        value_col = numeric_cols[0]

        # Prepare safe series: drop rows with missing category or missing value
        tmp = df[[category_col, value_col]].dropna(subset=[category_col, value_col]).copy()
        # Convert category labels to string
        tmp[category_col] = tmp[category_col].astype(str).str.strip()
        # Aggregate in case of duplicates (sum)
        agg = tmp.groupby(category_col, as_index=False, observed=False)[value_col].sum().sort_values(value_col, ascending=False).head(10)

        x = [str(x) for x in agg[category_col].tolist()]
        y = [float(v) if not pd.isna(v) else 0 for v in agg[value_col].tolist()]

        chart_config = {
            "title": {"text": f"{value_col} by {category_col}", "left": "center"},
            "tooltip": {"trigger": "axis", "axisPointer": {"type": "shadow"}},
            "xAxis": {"type": "category", "data": x, "axisLabel": {"rotate": 45}},
            "yAxis": {"type": "value", "name": value_col},
            "series": [{"name": value_col, "type": "bar", "data": y}]
        }
        return json.dumps(chart_config, indent=2)

    # Trend/line chart for numeric sequence-like data
    elif len(df) > 1 and numeric_cols:
        value_col = numeric_cols[0]
        x_data = df.index.tolist()
        y_data = [float(v) if not pd.isna(v) else None for v in df[value_col].tolist()]

        # replace None with null in JSON by leaving them as None (json dumps will convert)
        chart_config = {
            "title": {"text": f"Trend of {value_col}", "left": "center"},
            "tooltip": {"trigger": "axis"},
            "xAxis": {"type": "category", "data": [str(x) for x in x_data], "name": "Index"},
            "yAxis": {"type": "value", "name": value_col},
            "series": [{"name": value_col, "type": "line", "data": y_data, "smooth": True}]
        }
        return json.dumps(chart_config, indent=2)

    return None


def generate_series_chart(series, user_query):
    if series is None or len(series) == 0:
        return None

    # If index is meaningful, use it, else use sequential labels
    labels = [str(x) for x in series.index.tolist()]
    values = []
    for v in series.tolist():
        num = _safe_as_number(v)
        values.append(num if num is not None else v)

    if len(labels) <= 20:
        chart_config = {
            "title": {"text": f"Distribution of {series.name if series.name else 'Values'}", "left": "center"},
            "tooltip": {"trigger": "item"},
            "xAxis": {"type": "category", "data": labels, "axisLabel": {"rotate": 45}},
            "yAxis": {"type": "value"},
            "series": [{"name": "Values", "type": "bar", "data": values}]
        }
        return json.dumps(chart_config, indent=2)
    return None


def generate_basic_chart(data, user_query):
    """List/dict to basic bar chart"""
    if isinstance(data, dict) and len(data) <= 30:
        keys = [str(k) for k in data.keys()]
        values = []
        for v in data.values():
            num = _safe_as_number(v)
            values.append(num if num is not None else 0)
        chart_config = {
            "title": {"text": "Data Distribution", "left": "center"},
            "tooltip": {"trigger": "item"},
            "xAxis": {"type": "category", "data": keys, "axisLabel": {"rotate": 45}},
            "yAxis": {"type": "value"},
            "series": [{"name": "Values", "type": "bar", "data": values}]
        }
        return json.dumps(chart_config, indent=2)
    if isinstance(data, list) and len(data) <= 100:
        # If list of pairs
        if all(isinstance(x, (list, tuple)) and len(x) >= 2 for x in data[:20]):
            keys = [str(x[0]) for x in data]
            vals = [_safe_as_number(x[1]) or 0 for x in data]
            chart_config = {
                "title": {"text": "List Distribution", "left": "center"},
                "tooltip": {"trigger": "item"},
                "xAxis": {"type": "category", "data": keys, "axisLabel": {"rotate": 45}},
                "yAxis": {"type": "value"},
                "series": [{"name": "Values", "type": "bar", "data": vals}]
            }
            return json.dumps(chart_config, indent=2)
    return None


def generate_simple_chart(result_str, user_query):
    chart_config = {
        "title": {"text": "Analysis Result", "left": "center"},
        "graphic": {
            "type": "text",
            "left": "center",
            "top": "middle",
            "style": {"text": f"Result: {result_str[:200]}", "fontSize": 14, "fill": "#333"}
        }
    }
    return json.dumps(chart_config, indent=2)


# =====================================================
# 5. Build context from history
# =====================================================
def build_context_from_history(history_json):
    """Build context string from previous queries and responses"""
    if not history_json or history_json == "[]":
        return ""

    try:
        history = json.loads(history_json)
        context_lines = []
        for i, item in enumerate(history[-3:]):  # Last 3 queries for context
            query = item.get('query', '')
            summary = item.get('response', {}).get('summary', '')
            result = item.get('response', {}).get('result', '')[:200]  # Truncate long results

            context_lines.append(f"Previous Q {i + 1}: {query}")
            if summary:
                context_lines.append(f"Previous A {i + 1}: {summary}")
            if result:
                context_lines.append(f"Previous result {i + 1}: {result}")
            context_lines.append("---")

        return "\n".join(context_lines)
    except Exception as e:
        print(f"Could not parse history: {e}")
        return ""


# =====================================================
# 6 & 9. Generate code, execute, summarize and recommend
# (kept mostly the same, but more defensive)
# =====================================================

def apply_pandas_fixes(code):
    """Apply critical pandas compatibility fixes for Pandas 2.0+"""
    code = code.replace(", include_groups=False", "")
    code = code.replace("include_groups=False", "")

    # 2. Fix to_datetime: 
    if "pd.to_datetime(" in code and "errors=" not in code:
        code = re.sub(r"pd\.to_datetime\(([^)]+)\)", r"pd.to_datetime(\1, errors='coerce')", code)
    elif "pd.to_datetime(" in code:
        code = code.replace("infer_datetime_format=True", "")
        code = code.replace("infer_datetime_format=False", "")

    if ".groupby(" in code and ".apply(" in code and "group_keys=" not in code:
        code = re.sub(
            r"\.groupby\((.*?)\)\.apply\((.*?)\)",
            r".groupby(\1, group_keys=False).apply(\2)",
            code
        )

    code = re.sub(
        r"result\s*=\s*df\.loc\[(df\[['\"]?.+?['\"]?\])\.idxmax\(\)\]",
        r"max_val = \1.max()\nresult = df.loc[df[\1] == max_val]",
        code
    )
    code = re.sub(
        r"result\s*=\s*df\.loc\[(df\[['\"]?.+?['\"]?\])\.idxmin\(\)\]",
        r"min_val = \1.min()\nresult = df.loc[df[\1] == min_val]",
        code
    )

    return code


def generate_analysis_summary(client, user_query, result, error_msg):
    """Generate human-readable summary of analysis results"""
    result_preview = ""
    if result is not None:
        try:
            if isinstance(result, pd.DataFrame):
                result_preview = result.head(8).to_string()[:800]
            elif isinstance(result, pd.Series):
                result_preview = result.head(8).to_string()[:800]
            else:
                result_preview = str(result)[:800]
        except Exception:
            result_preview = str(type(result))
    elif error_msg:
        result_preview = f"Analysis encountered an error: {error_msg}"
    else:
        result_preview = "No analysis result available"

    result_preview = re.sub(r'[^\x20-\x7E]+', ' ', str(result_preview))

    prompt_summary = f"""User question: "{user_query}"
Analysis result: {result_preview}

Provide a clear, concise explanation of what the result shows. Focus on the key findings and what they mean.

Response:"""

    human_text = call_groq(client, prompt_summary, max_tokens=300, temperature=0.7)

    if human_text:
        print("\n=== Analysis Summary ===")
        print(human_text)
        return human_text
    else:
        fallback_text = "I analyzed your data. " + ("The results show meaningful patterns." if result is not None else "There was an issue with the analysis.")
        print("\n=== Analysis Summary ===")
        print(fallback_text)
        return fallback_text


def generate_recommended_prompts(df, user_query, result, client):
    """Generate follow-up questions (returns at least 3 fallback ones)"""
    try:
        result_preview = ""
        if result is not None:
            if hasattr(result, 'head'):
                result_preview = str(result.head(5))[:500]
            else:
                result_preview = str(result)[:500]

        prompt = f"""Based on this dataset analysis and the user's question, suggest 3 relevant follow-up questions.

Dataset columns: {list(df.columns)}
User's question: "{user_query}"
Analysis result preview: {result_preview}

IMPORTANT: You MUST return exactly 3 follow-up questions as a JSON array of strings.

Return ONLY a JSON array with exactly 3 strings, no explanations:
["question 1", "question 2", "question 3"]"""

        prompts_text = call_groq(client, prompt, max_tokens=300, temperature=0.7)
        if prompts_text:
            prompts_match = re.search(r'\[.*\]', prompts_text, re.DOTALL)
            if prompts_match:
                prompts = json.loads(prompts_match.group())
                if isinstance(prompts, list) and len(prompts) >= 1:
                    return prompts[:3]
    except Exception as e:
        print(f"Could not generate recommended prompts: {e}")

    # Fallback
    return [
        f"What are the trends in {list(df.columns)[0] if len(df.columns) > 0 else 'the data'}?",
        "How are different categories distributed?",
        "Show me summary statistics for numeric columns"
    ]


def generate_mimir_recommends(df, user_query, result, client):
    """Generate expert recommendations with Prediction and Cost of No Action logic"""
    try:
        result_preview = str(result.head(5))[:500] if hasattr(result, 'head') else str(result)[:500]

        prompt = f"""As Mimir, the wise data analyst, provide 2 expert recommendations based on this analysis.
        For each recommendation, you must provide:
        1. The Recommendation: What should be done.
        2. Cost of No Action: A simulation of the negative outcome if ignored.
        3. Cost Reasoning: The logic/mechanics of why that negative outcome occurs.
        4. Mimir Prediction: A simulation of the positive outcome if implemented.
        5. Prediction Reasoning: The logic/mechanics of why this positive change will happen.

        Dataset: {list(df.columns)}
        Question: "{user_query}"
        Result: {result_preview}

        Return ONLY a JSON array of objects with this structure:
        [
          {{
            "recommendation": "...",
            "cost_of_no_action": "...",
            "cost_reasoning": "...",
            "prediction": "...",
            "prediction_reasoning": "..."
          }}
        ]"""

        recs_text = call_groq(client, prompt, max_tokens=1000, temperature=0.6)
        if recs_text:
            recs_match = re.search(r'\[.*\]', recs_text, re.DOTALL)
            if recs_match:
                return json.loads(recs_match.group())
    except Exception as e:
        print(f"Error: {e}")
    return []


# =====================================================
# 9. Main Analysis Function
# =====================================================

def analyze_data(df, user_query, client, history_json=""):
    # Build context from history (but don't pass huge history to LLM directly)
    history_context = build_context_from_history(history_json)

    csv_preview = df.head(3).to_csv(index=False) if df.shape[0] > 0 else "Empty DataFrame"
    col_info = "\n".join([f"- {col}: {df[col].dtype}" for col in df.columns])

    prompt = f"""You are an expert Python data analyst. Generate clean, executable pandas code to analyze dataframe `df` and accurately answer the user's question.

CRITICAL RULES FOR PANDAS 2.0+ COMPATIBILITY:
1. NEVER use `include_groups=False`
2. For groupby operations, use `group_keys=False` instead
3. DO NOT import matplotlib or any plotting libraries - we handle charts separately
4. Use simple pandas operations without complex dependencies

DATASET INFO:
Columns and dtypes:
{col_info}

Data preview (first 3 rows):
{csv_preview}

USER QUESTION: {user_query}

Generate ONLY the Python code that:
1. Answers the question using pandas operations on `df`
2. Assigns the final result to variable `result`
3. Uses safe, compatible pandas syntax
4. Handles potential missing values
5. Does not use any plotting libraries

Code only:"""

    print("Generating pandas code...")
    raw_code = call_groq(client, prompt, max_tokens=600, temperature=0.1)

    if not raw_code:
        print("Failed to generate code")
        return None, None, None, None, None, "Failed to generate code"

    print("\n=== Raw LLM output ===")
    print(raw_code)

    # Extract and clean code
    code_clean = extract_code(raw_code)
    code_clean = re.sub(r"^```[a-zA-Z]*|```$", "", code_clean.strip(), flags=re.MULTILINE).strip()
    code_clean = apply_pandas_fixes(code_clean)

    print("\n=== Cleaned code ===")
    print(code_clean)

    result = None
    error_msg = None

    if len(code_clean) > 10:
        result, error_msg = safe_execute_code(code_clean, df)

        if result is None and error_msg:
            print(f"Error executing pandas code: {error_msg}")

            # Retry with a very simple fallback pattern if possible
            print("\nAttempting to fix the error with simplified code...")
            retry_prompt = f"""The previous code failed with this error: {error_msg}

Original question: "{user_query}"
Dataset columns: {list(df.columns)}

Generate SIMPLE, corrected Python code that:
1. Fixes the specific error above
2. Uses basic pandas operations only
3. Assigns result to 'result' variable
4. No complex operations, no plotting

Corrected code only:"""

            retry_code = call_groq(client, retry_prompt, max_tokens=400, temperature=0.1)
            if retry_code:
                retry_clean = extract_code(retry_code)
                retry_clean = re.sub(r"^```[a-zA-Z]*|```$", "", retry_clean.strip(), flags=re.MULTILINE).strip()
                retry_clean = apply_pandas_fixes(retry_clean)

                print("\n=== Retry code ===")
                print(retry_clean)

                result, retry_error = safe_execute_code(retry_clean, df)
                if retry_error:
                    print(f"Retry also failed: {retry_error}")
                    error_msg = f"Original: {error_msg}, Retry: {retry_error}"
                elif result is None:
                    print("Retry executed but 'result' not assigned")
                    error_msg = "Retry executed but 'result' not assigned"
                else:
                    error_msg = None
    else:
        print("No executable code detected")
        error_msg = "No executable code generated"

    # Generate summary and recommendations
    summary = generate_analysis_summary(client, user_query, result, error_msg)
    recommended_prompts = generate_recommended_prompts(df, user_query, result, client)
    mimir_recommends = generate_mimir_recommends(df, user_query, result, client)

    # Chart JSON generation
    chart_json = generate_chart_json(user_query, result)

    return summary, recommended_prompts, mimir_recommends, chart_json, result, error_msg


# =====================================================
# 10. Entry point - supports history passed as @<tempfile>
# =====================================================

def read_history_arg(arg: str) -> str:
    """If arg starts with '@', treat as file path and read JSON from it.
    Otherwise treat as the JSON string itself.
    """
    if not arg:
        return "[]"
    if arg.startswith("@"):
        path = arg[1:]
        try:
            with open(path, "r", encoding="utf-8") as f:
                return f.read()
        except Exception as e:
            print(f"Failed to read history file {path}: {e}")
            return "[]"
    return arg

def main_loop():

    sys.stdin = io.TextIOWrapper(sys.stdin.buffer, encoding='utf-8')
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

    client = None
    # Pre-initialize these so they persist in memory
    print("PYTHON_READY", flush=True)

    for line in sys.stdin:
        try:
            input_data = json.loads(line)
            
            csv_path = input_data.get("csv_path")
            query = input_data.get("query")
            history_json = input_data.get("history", "[]")
            api_key = input_data.get("api_key")

            if api_key:
                os.environ["GROQ_API_KEY"] = api_key
            
            if client is None:
                client = load_groq_client()

            df = load_clean_csv(csv_path)
            summary, rec_prompts, mimir_recs, chart, result, error = analyze_data(
                df, query, client, history_json
            )

            response = {
                "raw_output": str(result)[:1000] if result is not None else "", 
                "code": "Check Python Logs",                                    
                "result": "success" if error is None else "error",
                "summary": summary,
                "recommended_prompts": rec_prompts,
                "mimir_recommends": mimir_recs,
                "chart": chart,
                "error": error
            }
            
            print("===RESULT_START===")
            print(json.dumps(response))
            print("===RESULT_END===", flush=True)

        except Exception as e:
            err_resp = {
                "summary": "Encoding or Parsing Error",
                "raw_output": "",
                "code": "",
                "result": "error",
                "error": str(e)
            }
            print("===RESULT_START===")
            print(json.dumps(err_resp))
            print("===RESULT_END===", flush=True)

if __name__ == "__main__":
    main_loop()
