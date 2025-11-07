import os
import re
import json
import pandas as pd
import numpy as np
from groq import Groq
import sys
import matplotlib
matplotlib.use('Agg')  # Set non-interactive backend


def check_file_type(file_path):
    ext = os.path.splitext(file_path)[1].lower()

    if ext == '.csv':
        return 'csv'
    elif ext in ['.xlsx', '.xls']:
        return 'excel'
    else:
        return 'unknown'

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
                
                if df is not None and df.shape[1] > 1 and df.shape[0] > 0:
                    print(f"Loaded successfully with sep='{sep}' encoding='{enc}' → {df.shape}")
                    loaded = True
                    break
            except Exception as e:
                print(f"Failed with encoding {enc}, separator {sep}: {e}")
                continue
        if loaded:
            break

    if not loaded or df is None:
        # Final attempt with default parameters
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

    # Strip non-printable chars and junk
    df = df.map(lambda x: re.sub(r"[^\x20-\x7E]", "", str(x)) if isinstance(x, str) else x)
    df.replace({
        "nan": None,
        "NaN": None,
        ".": None,
        "-": None,
        "--": None,
        "": None
    }, inplace=True)

    df.dropna(axis=1, how="all", inplace=True)
    if df.shape[0] > 0:
        df.dropna(axis=0, thresh=int(df.shape[1] * 0.3), inplace=True)

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
            "Get your free API key at: https://console.groq.com/keys\n"
            "Then set it: export GROQ_API_KEY='your-key-here'"
        )
    
    print("Connected to Groq API (Llama 3.3 70B)")
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
                                  "Speak only in natural language, never output code or symbols "
                                  "unless explicitly asked."},
                      {"role": role, "content": prompt}],
            max_tokens=max_tokens,
            temperature=temperature
        )
        text = response.choices[0].message.content.strip()

        # If output seems incomplete, request a clean continuation
        if text.endswith("...") or len(text.split()) > 0.95 * max_tokens:
            print("Output may be incomplete — requesting continuation...")
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
    # First try to find code blocks
    code_block_match = re.search(r'```(?:python)?\s*\n(.*?)\n```', text, re.DOTALL)
    if code_block_match:
        return code_block_match.group(1).strip()
    
    # Otherwise, try to extract lines that look like Python code
    lines = text.split('\n')
    code_lines = []
    
    for line in lines:
        stripped = line.strip()
        # Skip empty lines, comments, and explanatory text
        if not stripped or stripped.startswith('#'):
            continue
        # Check if line looks like Python code
        if any([
            stripped.startswith('import '),
            stripped.startswith('from '),
            'df.' in stripped or 'df[' in stripped,
            stripped.startswith('result ='),
            '=' in stripped and not stripped.startswith('To ')
        ]):
            code_lines.append(line)
    
    return '\n'.join(code_lines) if code_lines else text


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
            
            context_lines.append(f"Previous Q {i+1}: {query}")
            if summary:
                context_lines.append(f"Previous A {i+1}: {summary}")
            if result:
                context_lines.append(f"Previous result {i+1}: {result}")
            context_lines.append("---")
        
        return "\n".join(context_lines)
    except Exception as e:
        print(f"Could not parse history: {e}")
        return ""


# =====================================================
# 6. Generate additional insights - ALWAYS PROVIDE THESE
# =====================================================

def generate_recommended_prompts(df, user_query, result, client):
    """Generate follow-up questions based on the current analysis - ALWAYS provide at least 3"""
    try:
        # Get result preview for context
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

Focus on:
- Natural follow-up questions based on the current analysis
- Deeper exploration of patterns found
- Related aspects of the data not yet explored

Return ONLY a JSON array with exactly 3 strings, no explanations:

["question 1", "question 2", "question 3"]"""

        print("Generating recommended prompts...")
        prompts_text = call_groq(client, prompt, max_tokens=400, temperature=0.7)
        
        if prompts_text:
            try:
                # Extract JSON array
                prompts_match = re.search(r'\[.*\]', prompts_text, re.DOTALL)
                if prompts_match:
                    prompts = json.loads(prompts_match.group())
                    if len(prompts) >= 2:  # Ensure we have at least 2
                        return prompts[:3]  # Return max 3
            except Exception as e:
                print(f"Could not parse recommended prompts: {e}")
        
        # Fallback prompts if LLM fails
        fallback_prompts = [
            f"What are the trends in {list(df.columns)[0] if len(df.columns) > 0 else 'the data'}?",
            f"How are different categories distributed?",
            f"Show me summary statistics for numeric columns"
        ]
        print("Using fallback recommended prompts")
        return fallback_prompts
        
    except Exception as e:
        print(f"Error generating recommended prompts: {e}")
        # Return basic fallback prompts
        return [
            "Show me more detailed statistics",
            "What are the correlations between numeric columns?",
            "Are there any outliers in the data?"
        ]


def generate_mimir_recommends(df, user_query, result, client):
    """Generate Mimir's expert recommendations based on the analysis - ALWAYS provide at least 2"""
    try:
        # Get result preview for context
        result_preview = ""
        if result is not None:
            if hasattr(result, 'head'):
                result_preview = str(result.head(5))[:500]
            else:
                result_preview = str(result)[:500]
        
        error_info = ""
        if result is None:
            error_info = " (Note: Previous analysis had issues)"

        prompt = f"""As Mimir, the wise data analyst AI, provide 2 expert recommendations based on this analysis.

Dataset info: {list(df.columns)}
User's question: "{user_query}"
Analysis result preview: {result_preview}{error_info}

IMPORTANT: You MUST return exactly 2 insightful recommendations as a JSON array of strings.

Provide 2 recommendations that:
1. Highlight important patterns or insights discovered
2. Suggest next steps for deeper analysis

Be concise, professional, and helpful. Return ONLY a JSON array with exactly 2 strings:

["recommendation 1", "recommendation 2"]"""

        recommendations_text = call_groq(client, prompt, max_tokens=400, temperature=0.3)
        
        if recommendations_text:
            try:
                # Extract JSON array
                recs_match = re.search(r'\[.*\]', recommendations_text, re.DOTALL)
                if recs_match:
                    recommendations = json.loads(recs_match.group())
                    if len(recommendations) >= 1:  # Ensure we have at least 1
                        return recommendations[:2]  # Return max 2
            except Exception as e:
                print(f"Could not parse Mimir recommendations: {e}")
        
        # Fallback recommendations if LLM fails
        fallback_recs = [
            "Consider analyzing data quality and missing values for more reliable insights",
            "Explore categorical variable distributions to understand data composition"
        ]
        print("Using fallback Mimir recommendations")
        return fallback_recs
        
    except Exception as e:
        print(f"Error generating Mimir recommendations: {e}")
        # Return basic fallback recommendations
        return [
            "Review data quality and completeness before deeper analysis",
            "Consider segmenting analysis by key categorical variables"
        ]


# =====================================================
# 7. Safe code execution with import fixes
# =====================================================

def safe_execute_code(code, df):
    """Safely execute pandas code with proper imports and error handling"""
    # Remove import statements since modules are already available
    code_clean = re.sub(r'^\s*(import|from)\s+.*$', '', code, flags=re.MULTILINE)
    
    # Add matplotlib workaround - use Agg backend and import
    if 'plt.' in code_clean or 'matplotlib' in code_clean:
        code_clean = "import matplotlib\nmatplotlib.use('Agg')\nimport matplotlib.pyplot as plt\n" + code_clean
    
    # Create safe execution environment
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
        return local_env.get("result"), None
    except Exception as e:
        return None, str(e)


# =====================================================
# 8. Enhanced Chart Generation
# =====================================================

def generate_chart_json(user_query, result):
    """Generate ECharts compatible JSON based on analysis result"""
    if result is None:
        return None
        
    try:
        # Handle different result types
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
        
    # Determine chart type based on data and query
    numeric_cols = df.select_dtypes(include=[np.number]).columns.tolist()
    categorical_cols = df.select_dtypes(include=['object']).columns.tolist()
    
    # Simple bar chart for small categorical data
    if len(df) <= 15 and len(categorical_cols) >= 1 and len(numeric_cols) >= 1:
        category_col = categorical_cols[0]
        value_col = numeric_cols[0] if numeric_cols else df.columns[1]
        
        # Get top categories by value
        chart_data = df.head(10).sort_values(value_col, ascending=False)
        
        chart_config = {
            "title": {
                "text": f"{value_col} by {category_col}",
                "left": "center"
            },
            "tooltip": {
                "trigger": "axis",
                "axisPointer": {
                    "type": "shadow"
                }
            },
            "xAxis": {
                "type": "category",
                "data": chart_data[category_col].tolist(),
                "axisLabel": {
                    "rotate": 45
                }
            },
            "yAxis": {
                "type": "value",
                "name": value_col
            },
            "series": [{
                "name": value_col,
                "type": "bar",
                "data": chart_data[value_col].tolist(),
                "itemStyle": {
                    "color": "#5470c6"
                }
            }]
        }
        return json.dumps(chart_config, indent=2)
    
    # Line chart for time series or sequential data
    elif len(df) > 1 and len(numeric_cols) >= 1:
        # Try to find a sequence (index or first column)
        x_data = df.index.tolist() if not df.index.equals(pd.RangeIndex(start=0, stop=len(df))) else list(range(len(df)))
        value_col = numeric_cols[0]
        
        chart_config = {
            "title": {
                "text": f"Trend of {value_col}",
                "left": "center"
            },
            "tooltip": {
                "trigger": "axis"
            },
            "xAxis": {
                "type": "category",
                "data": x_data,
                "name": "Index"
            },
            "yAxis": {
                "type": "value",
                "name": value_col
            },
            "series": [{
                "name": value_col,
                "type": "line",
                "data": df[value_col].tolist(),
                "smooth": True,
                "itemStyle": {
                    "color": "#5470c6"
                }
            }]
        }
        return json.dumps(chart_config, indent=2)
    
    return None

def generate_series_chart(series, user_query):
    """Generate chart for Series results"""
    if len(series) == 0:
        return None
        
    # Convert series to list for charting
    if len(series) <= 20:
        chart_config = {
            "title": {
                "text": f"Distribution of {series.name if series.name else 'Values'}",
                "left": "center"
            },
            "tooltip": {
                "trigger": "item"
            },
            "xAxis": {
                "type": "category",
                "data": [str(x) for x in series.index.tolist()],
                "axisLabel": {
                    "rotate": 45
                }
            },
            "yAxis": {
                "type": "value"
            },
            "series": [{
                "name": "Values",
                "type": "bar",
                "data": series.tolist(),
                "itemStyle": {
                    "color": "#91cc75"
                }
            }]
        }
        return json.dumps(chart_config, indent=2)
    
    return None

def generate_basic_chart(data, user_query):
    """Generate basic chart for list/dict results"""
    if isinstance(data, dict) and len(data) <= 20:
        keys = list(data.keys())
        values = list(data.values())
        
        chart_config = {
            "title": {
                "text": "Data Distribution",
                "left": "center"
            },
            "tooltip": {
                "trigger": "item"
            },
            "xAxis": {
                "type": "category",
                "data": [str(k) for k in keys],
                "axisLabel": {
                    "rotate": 45
                }
            },
            "yAxis": {
                "type": "value"
            },
            "series": [{
                "name": "Values",
                "type": "bar",
                "data": values,
                "itemStyle": {
                    "color": "#fac858"
                }
            }]
        }
        return json.dumps(chart_config, indent=2)
    
    return None

def generate_simple_chart(result_str, user_query):
    """Generate a simple text-based visualization for other result types"""
    # For non-chartable results, return a simple text display
    chart_config = {
        "title": {
            "text": "Analysis Result",
            "left": "center"
        },
        "graphic": {
            "type": "text",
            "left": "center",
            "top": "middle",
            "style": {
                "text": f"Result: {result_str[:100]}...",
                "fontSize": 14,
                "fill": "#333"
            }
        }
    }
    return json.dumps(chart_config, indent=2)


# =====================================================
# 9. Main Analysis Function
# =====================================================

def analyze_data(df, user_query, client, history_json=""):
    # Build context from history
    history_context = build_context_from_history(history_json)
    
    # Create safer previews
    csv_preview = df.head(3).to_csv(index=False) if df.shape[0] > 0 else "Empty DataFrame"
    col_info = "\n".join([f"- {col}: {df[col].dtype}" for col in df.columns])
    
    prompt = f"""You are an expert Python data analyst. Generate clean, executable pandas code to analyze dataframe `df` and accurately answer the user's question.

CRITICAL RULES FOR PANDAS 2.0+ COMPATIBILITY:
1. NEVER use `include_groups=False` - this parameter was removed in pandas 2.0
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

    # Extract clean code
    code_clean = extract_code(raw_code)
    
    # Remove any remaining code fences and explanations
    code_clean = re.sub(r"^```[a-zA-Z]*|```$", "", code_clean.strip(), flags=re.MULTILINE).strip()
    
    # Apply critical fixes for pandas compatibility
    code_clean = apply_pandas_fixes(code_clean)
    
    print("\n=== Cleaned code ===")
    print(code_clean)

    result = None
    error_msg = None
    
    if len(code_clean) > 10:  # Minimum viable code length
        result, error_msg = safe_execute_code(code_clean, df)
        
        if result is None and error_msg:
            print(f"Error executing pandas code: {error_msg}")
            
            # Retry with simpler approach
            print("\nAttempting to fix the error...")
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
                    error_msg = None  # Clear error since retry succeeded
                    
        if result is not None:
            print("\n=== Result ===")
            # Handle different result types safely
            if hasattr(result, 'head'):
                print(result.head(10).to_string())
            else:
                print(str(result)[:1000])  # Limit output length
    else:
        print("No executable code detected")
        error_msg = "No executable code generated"

    # Generate summary
    summary = generate_analysis_summary(client, user_query, result, error_msg)
    
    # Generate recommendations
    recommended_prompts = generate_recommended_prompts(df, user_query, result, client)
    mimir_recommends = generate_mimir_recommends(df, user_query, result, client)
    
    # Generate chart data using our enhanced function
    chart_json = generate_chart_json(user_query, result)

    return summary, recommended_prompts, mimir_recommends, chart_json, result, error_msg


def apply_pandas_fixes(code):
    """Apply critical pandas compatibility fixes"""
    # Remove include_groups=False
    code = code.replace(", include_groups=False", "")
    code = code.replace("include_groups=False", "")
    
    # Add group_keys=False to groupby().apply()
    if "groupby(" in code and ".apply(" in code and "group_keys=False" not in code:
        code = re.sub(
            r"\.groupby\((.*?)\)\.apply\((.*?)\)",
            r".groupby(\1, group_keys=False).apply(\2)",
            code
        )
    
    # Fix common idxmax/idxmin patterns to return all matching rows
    if ".idxmax()" in code or ".idxmin()" in code:
        if "df.loc[df[" not in code:
            code = re.sub(
                r"result\s*=\s*df\.loc\[(.*?)\.idxmax\(\)\]",
                r"max_val = \1.max()\nresult = df[\1 == max_val]",
                code
            )
            code = re.sub(
                r"result\s*=\s*df\.loc\[(.*?)\.idxmin\(\)\]",
                r"min_val = \1.min()\nresult = df[\1 == min_val]",
                code
            )
    
    # Remove matplotlib imports and usage
    code = re.sub(r'^\s*(import matplotlib|import plt|from matplotlib).*$', '', code, flags=re.MULTILINE)
    code = re.sub(r'^\s*plt\.\w+\(.*$', '', code, flags=re.MULTILINE)
    
    return code


def generate_analysis_summary(client, user_query, result, error_msg):
    """Generate human-readable summary of analysis results"""
    result_preview = ""
    if result is not None:
        if hasattr(result, 'head'):
            result_preview = result.head(8).to_string()[:800]
        else:
            result_preview = str(result)[:800]
    elif error_msg:
        result_preview = f"Analysis encountered an error: {error_msg}"
    else:
        result_preview = "No analysis result available"

    # Clean non-printable characters
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


# =====================================================
# 10. Entry point - WINDOWS COMPATIBLE OUTPUT FORMAT
# =====================================================

if __name__ == "__main__":
    if len(sys.argv) < 4:
        print("Usage: python analyzer.py <csv_path> <query> <history_json>")
        sys.exit(1)
    
    csv_path = sys.argv[1]
    query = sys.argv[2]
    history_json = sys.argv[3]
    
    try:
        # Set working directory to script directory to avoid path issues
        script_dir = os.path.dirname(os.path.abspath(__file__))
        os.chdir(script_dir)
        
        client = load_groq_client()
        df = load_clean_csv(csv_path)
        
        if df.shape[0] == 0:
            raise ValueError("DataFrame is empty after loading and cleaning")
            
        summary, recommended_prompts, mimir_recommends, chart, result, error = analyze_data(df, query, client, history_json)
        
        # Output with clear section markers
        print("\n=== ANALYSIS_SUMMARY_START ===")
        print(summary if summary else "No summary available")
        print("=== ANALYSIS_SUMMARY_END ===")
        
        print("\n=== RECOMMENDED_PROMPTS_START ===")
        print(json.dumps(recommended_prompts if recommended_prompts else []))
        print("=== RECOMMENDED_PROMPTS_END ===")
        
        print("\n=== MIMIR_RECOMMENDS_START ===")
        print(json.dumps(mimir_recommends if mimir_recommends else []))
        print("=== MIMIR_RECOMMENDS_END ===")
        
        print("\n=== CHART_DATA_START ===")
        if chart:
            print(chart)
        else:
            print("null")
        print("=== CHART_DATA_END ===")
        
        if error:
            print("\n=== ERROR_INFO_START ===")
            print(error)
            print("=== ERROR_INFO_END ===")
            
    except Exception as e:
        print(f"Fatal error: {e}")
        # Provide structured output even on error
        print("\n=== ANALYSIS_SUMMARY_START ===")
        print(f"Error loading or analyzing data: {e}")
        print("=== ANALYSIS_SUMMARY_END ===")
        print("\n=== RECOMMENDED_PROMPTS_START ===")
        print("[]")
        print("=== RECOMMENDED_PROMPTS_END ===")
        print("\n=== MIMIR_RECOMMENDS_START ===")
        print("[]")
        print("=== MIMIR_RECOMMENDS_END ===")
        print("\n=== CHART_DATA_START ===")
        print("null")
        print("=== CHART_DATA_END ===")
        print("\n=== ERROR_INFO_START ===")
        print(str(e))
        print("=== ERROR_INFO_END ===")
        sys.exit(1)
