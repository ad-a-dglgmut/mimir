#!/usr/bin/env python3
import os
import io
import re
import json
import sys
import pandas as pd
import numpy as np
from groq import Groq
import matplotlib

# Use Agg backend for any possible plotting in executed code (non-interactive)
matplotlib.use('Agg')

# =====================================================
# Config
# =====================================================
# Set this to the model you switched to after the deprecation.
# You can also override it without touching code via the GROQ_MODEL env var.
GROQ_MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")

SYSTEM_PROSE = (
    "You are a helpful, concise data analyst. "
    "Reply in plain prose only. Never use markdown, tables, pipes, bullet lists, "
    "headers, bold text, or code blocks. Never reproduce rows or columns of data; "
    "describe findings in words."
)
SYSTEM_CODE = (
    "You are an expert Python and pandas programmer. "
    "Output only executable Python code, with no explanations."
)
SYSTEM_JSON = (
    "You are a data analyst that outputs only valid JSON. "
    "No markdown fences, no commentary before or after the JSON."
)
SYSTEMS = {"prose": SYSTEM_PROSE, "code": SYSTEM_CODE, "json": SYSTEM_JSON}


def log_err(msg):
    """Errors go to stderr so they show up in the terminal (Rust inherits stderr)."""
    print(msg, file=sys.stderr, flush=True)


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

    df.columns = [str(c).strip().lower().replace(" ", "_").replace("-", "_") if str(c).strip() != "" else f"col_{i}"
                  for i, c in enumerate(df.columns)]

    for col in df.columns:
        if df[col].dtype == object or df[col].dtype.name == 'string':
            df[col] = df[col].astype(str).apply(strip_nonprintable).replace({'nan': None, 'None': None})

    for col in df.columns:
        sample = df[col].dropna().astype(str).head(100)
        if sample.empty:
            continue

        cleaned = sample.str.replace(r'[\$\£\€\¥,]', '', regex=True).str.replace(r'\s+', '', regex=True)
        looks_numeric = cleaned.str.match(r'^-?\d+(\.\d+)?$')
        numeric_ratio = float(looks_numeric.sum()) / float(len(cleaned))
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
                    print(f"Loaded successfully with sep='{sep}' encoding='{enc}' -> {df.shape}")
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
            print(f"Loaded with default parameters -> {df.shape}")
        except Exception as e:
            raise ValueError(f"Could not parse file: {e}")

    df.columns = [
        str(c).strip().lower().replace(" ", "_").replace("-", "_")
        if str(c).strip() != "" else f"col_{i}"
        for i, c in enumerate(df.columns)
    ]

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

def load_groq_client(api_key=None):
    api_key = (api_key or os.getenv("GROQ_API_KEY") or "").strip().strip('"').strip("'")
    if not api_key:
        raise ValueError(
            "GROQ_API_KEY not found. Pass it from the app or set it in your environment."
        )

    print("Connected to Groq API (client available)")
    return Groq(api_key=api_key)


# =====================================================
# 3. Call Groq API
# =====================================================

def call_groq(client, prompt, max_tokens=500, temperature=0.1, mode="prose"):
    """
    Call the Groq API.
    mode: "prose" (plain-text answers), "code" (Python only), "json" (JSON only).
    On failure returns None and stores the reason in call_groq.last_error.
    """
    system_prompt = SYSTEMS.get(mode, SYSTEM_PROSE)
    try:
        response = client.chat.completions.create(
            model=GROQ_MODEL,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": prompt},
            ],
            max_tokens=max_tokens,
            temperature=temperature,
        )
        choice = response.choices[0]
        text = (choice.message.content or "").strip()

        if choice.finish_reason == "length":
            log_err(f"Warning: response hit max_tokens={max_tokens} (mode={mode}); output may be cut off")

        if not text:
            # Reasoning models can spend the whole budget thinking and return nothing.
            raise ValueError(
                f"Empty response from model '{GROQ_MODEL}' (finish_reason={choice.finish_reason}). "
                f"Try raising max_tokens."
            )

        call_groq.last_error = ""
        return text
    except Exception as e:
        call_groq.last_error = f"{type(e).__name__}: {e}"
        log_err(f"Groq API error (model={GROQ_MODEL}): {call_groq.last_error}")
        return None


call_groq.last_error = ""


# =====================================================
# Text helpers
# =====================================================

def to_plain_text(text):
    """Strip markdown tables, code fences, headers, bold, and bullets."""
    if not text:
        return text
    text = re.sub(r'```.*?```', '', text, flags=re.DOTALL)
    kept = []
    for line in text.splitlines():
        if line.count('|') >= 2:  # table row or separator
            continue
        kept.append(line)
    text = "\n".join(kept)
    text = re.sub(r'\*\*(.*?)\*\*', r'\1', text)
    text = re.sub(r'(?m)^\s{0,3}#{1,6}\s*', '', text)
    text = re.sub(r'(?m)^\s*[-*\u2022]\s+', '', text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()


def parse_json_block(text, opener, closer):
    """Pull the first JSON array/object out of an LLM reply. Returns None if it can't."""
    if not text:
        return None
    text = re.sub(r'```(?:json)?', '', text)
    start = text.find(opener)
    end = text.rfind(closer)
    if start == -1 or end == -1 or end <= start:
        return None
    try:
        return json.loads(text[start:end + 1])
    except Exception:
        return None


# =====================================================
# 4. Extract clean Python code from LLM response
# =====================================================

def extract_code(text):
    """Extract only Python code from LLM response, removing explanations."""
    if not text:
        return ""

    code_block_match = re.search(r'```(?:python)?\s*\n?(.*?)```', text, re.DOTALL)
    if code_block_match:
        return code_block_match.group(1).strip()

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
            re.match(r'^[\w_]+\s*=', stripped)
        ]):
            code_lines.append(line)
    return '\n'.join(code_lines).strip() or text


# =====================================================
# 7. Safe code execution with import fixes
# =====================================================

def safe_execute_code(code, df):
    """Safely execute pandas code with proper imports and error handling."""
    code_clean = re.sub(r'^\s*(import|from)\s+.*$', '', code, flags=re.MULTILINE)

    if 'plt.' in code_clean or 'matplotlib' in code_clean:
        code_clean = "import matplotlib\nmatplotlib.use('Agg')\nimport matplotlib.pyplot as plt\n" + code_clean

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

    local_env = {
        "pd": pd,
        "df": df,
        "np": np,
        "__builtins__": safe_builtins
    }

    try:
        exec(code_clean, local_env, local_env)
        raw_result = local_env.get("result", None)
        processed_result = postprocess_result(raw_result)
        return processed_result, None
    except Exception as e:
        return None, str(e)


def postprocess_result(result):
    """Convert numpy arrays / object arrays / DataFrames / Series to friendly types."""
    if isinstance(result, pd.DataFrame):
        return result

    if isinstance(result, pd.Series):
        return result

    if isinstance(result, np.ndarray):
        try:
            return result.tolist()
        except Exception:
            return [str(x) for x in result.flatten()]

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

    df = df.copy()

    numeric_cols = df.select_dtypes(include=[np.number]).columns.tolist()
    categorical_cols = df.select_dtypes(include=['object', 'string']).columns.tolist()

    if not numeric_cols:
        for col in df.columns:
            coerced = pd.to_numeric(df[col], errors='coerce')
            if coerced.notna().sum() > 0:
                numeric_cols.append(col)
                df[col] = coerced
                break

    if len(df) <= 15 and categorical_cols and numeric_cols:
        category_col = categorical_cols[0]
        value_col = numeric_cols[0]

        tmp = df[[category_col, value_col]].dropna(subset=[category_col, value_col]).copy()
        tmp[category_col] = tmp[category_col].astype(str).str.strip()
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

    elif len(df) > 1 and numeric_cols:
        value_col = numeric_cols[0]
        x_data = df.index.tolist()
        y_data = [float(v) if not pd.isna(v) else None for v in df[value_col].tolist()]

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
            response = item.get('response', {}) or {}
            # Old stored summaries may contain tables; clean them before reuse
            summary = to_plain_text(response.get('summary', '') or '')
            result = (response.get('result', '') or '')[:200]

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
# =====================================================

def apply_pandas_fixes(code):
    """Apply critical pandas compatibility fixes for Pandas 2.0+"""
    code = code.replace(", include_groups=False", "")
    code = code.replace("include_groups=False", "")

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
    """Generate a plain-text, human-readable summary of analysis results"""
    result_preview = ""
    if result is not None:
        try:
            if isinstance(result, (pd.DataFrame, pd.Series)):
                result_preview = result.head(8).to_string()[:800]
            else:
                result_preview = str(result)[:800]
        except Exception:
            result_preview = str(type(result))
    elif error_msg:
        result_preview = f"Analysis encountered an error: {error_msg}"
    else:
        result_preview = "No analysis result available"

    result_preview = re.sub(r'[^\x20-\x7E\n]+', ' ', str(result_preview))

    prompt_summary = f"""User question: "{user_query}"
Analysis result (for your reference only, do not copy it):
{result_preview}

Write 2 to 4 plain sentences explaining what the result shows and the key findings.
Rules: plain text only. No tables, no pipes, no lists, no markdown, no column dumps.
Describe the data in words, mention only the most important values, and never reproduce rows.

Response:"""

    human_text = call_groq(client, prompt_summary, max_tokens=800, temperature=0.3, mode="prose")
    human_text = to_plain_text(human_text)

    if human_text:
        print("\n=== Analysis Summary ===")
        print(human_text)
        return human_text

    fallback_text = "I analyzed your data. " + (
        "The results show meaningful patterns." if result is not None else "There was an issue with the analysis."
    )
    print("\n=== Analysis Summary ===")
    print(fallback_text)
    return fallback_text


def generate_recommended_prompts(df, user_query, result, client):
    """Generate follow-up questions (returns fallback ones on failure)"""
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

Return ONLY a JSON array with exactly 3 strings, no explanations:
["question 1", "question 2", "question 3"]"""

        prompts_text = call_groq(client, prompt, max_tokens=800, temperature=0.7, mode="json")
        prompts = parse_json_block(prompts_text, "[", "]")
        if isinstance(prompts, list):
            prompts = [str(p) for p in prompts if isinstance(p, str) and p.strip()]
            if prompts:
                return prompts[:3]
    except Exception as e:
        print(f"Could not generate recommended prompts: {e}")

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
1. recommendation: What should be done.
2. cost_of_no_action: The negative outcome if ignored.
3. cost_reasoning: The logic of why that negative outcome occurs.
4. prediction: The positive outcome if implemented.
5. prediction_reasoning: The logic of why this positive change will happen.

Write every value as plain sentences. No markdown, no tables, no lists.

Dataset columns: {list(df.columns)}
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

        recs_text = call_groq(client, prompt, max_tokens=1500, temperature=0.6, mode="json")
        recs = parse_json_block(recs_text, "[", "]")
        if isinstance(recs, list):
            keys = ["recommendation", "cost_of_no_action", "cost_reasoning", "prediction", "prediction_reasoning"]
            cleaned = []
            for r in recs:
                if isinstance(r, dict):
                    cleaned.append({k: to_plain_text(str(r.get(k, "") or "")) for k in keys})
            if cleaned:
                return cleaned[:2]
    except Exception as e:
        print(f"Error generating Mimir recommendations: {e}")
    return []


# =====================================================
# 9. Main Analysis Function
# =====================================================

def analyze_data(df, user_query, client, history_json=""):
    # Context from previous turns (now sanitized, available for prompts that want it)
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
    raw_code = call_groq(client, prompt, max_tokens=1500, temperature=0.1, mode="code")

    if not raw_code:
        reason = call_groq.last_error or "unknown"
        print("Failed to generate code")
        return "", None, None, None, None, f"Failed to generate code: {reason}"

    print("\n=== Raw LLM output ===")
    print(raw_code)

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

            retry_code = call_groq(client, retry_prompt, max_tokens=1200, temperature=0.1, mode="code")
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

    summary = generate_analysis_summary(client, user_query, result, error_msg)
    recommended_prompts = generate_recommended_prompts(df, user_query, result, client)
    mimir_recommends = generate_mimir_recommends(df, user_query, result, client)
    chart_json = generate_chart_json(user_query, result)

    return summary, recommended_prompts, mimir_recommends, chart_json, result, error_msg


# =====================================================
# 10. Entry point - long-running service driven by Rust over stdin/stdout
# =====================================================

def emit(response):
    print("===RESULT_START===")
    print(json.dumps(response))
    print("===RESULT_END===", flush=True)


def main_loop():
    sys.stdin = io.TextIOWrapper(sys.stdin.buffer, encoding='utf-8')
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

    client = None
    current_key = None

    print("PYTHON_READY", flush=True)

    for line in sys.stdin:
        try:
            input_data = json.loads(line)

            csv_path = input_data.get("csv_path")
            query = input_data.get("query")
            history_json = input_data.get("history", "[]")
            api_key = (input_data.get("api_key") or "").strip().strip('"').strip("'")

            # Recreate the client whenever the key changes (e.g. after a token refresh)
            if client is None or (api_key and api_key != current_key):
                client = load_groq_client(api_key or None)
                current_key = api_key

            df = load_clean_csv(csv_path)
            summary, rec_prompts, mimir_recs, chart, result, error = analyze_data(
                df, query, client, history_json
            )

            # The Rust side needs a string here, never null
            if not summary:
                summary = f"Analysis failed: {error}" if error else ""

            emit({
                "raw_output": str(result)[:1000] if result is not None else "",
                "code": "Check Python Logs",
                "result": "success" if error is None else "error",
                "summary": summary,
                "recommended_prompts": rec_prompts or [],
                "mimir_recommends": mimir_recs or [],
                "chart": chart,
                "error": error
            })

        except Exception as e:
            log_err(f"Unhandled error in main_loop: {type(e).__name__}: {e}")
            emit({
                "summary": f"Error: {e}",
                "raw_output": "",
                "code": "",
                "result": "error",
                "recommended_prompts": [],
                "mimir_recommends": [],
                "chart": None,
                "error": str(e)
            })


if __name__ == "__main__":
    main_loop()
