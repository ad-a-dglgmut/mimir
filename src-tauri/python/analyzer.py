import os
import re
import json
import pandas as pd
import numpy as np
from groq import Groq
import sys


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

    encodings = ["utf-8-sig", "utf-16", "latin1", "windows-1252"]
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
                    df = pd.read_excel(
                        csv_path
                    )
                if df is not None and df.shape[1] > 1 and df.shape[0] > 0:
                    print(f"Loaded successfully with sep='{sep}' encoding='{enc}' → {df.shape}")
                    loaded = True
                    break
            except Exception:
                continue
        if loaded:
            break

    if not loaded or df is None:
        raise ValueError("Could not parse CSV file with common encodings/delimiters.")

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
    df.dropna(axis=0, thresh=int(df.shape[1] * 0.3), inplace=True)

    print("Cleaned columns:", list(df.columns))
    print(df.head(5).to_string())
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
            text = continuation.choices[0].message.content.strip()

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
        
        for i, item in enumerate(history[-5:]):  # Last 5 queries for context
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
                result_preview = str(result.head(10))[:800]
            else:
                result_preview = str(result)[:800]
        
        prompt = f"""Based on this dataset analysis and the user's question, suggest 3-4 relevant follow-up questions.

Dataset columns: {list(df.columns)}
User's question: "{user_query}"
Analysis result preview: {result_preview}

IMPORTANT: You MUST return exactly 3-4 follow-up questions as a JSON array of strings.

Focus on:
- Natural follow-up questions based on the current analysis
- Deeper exploration of patterns found
- Related aspects of the data not yet explored
- Practical business or analytical questions

Return ONLY a JSON array with exactly 3-4 strings, no explanations:

["question 1", "question 2", "question 3", "question 4"]"""

        print("Generating recommended prompts...")
        prompts_text = call_groq(client, prompt, max_tokens=500, temperature=0.7)
        
        if prompts_text:
            try:
                # Extract JSON array
                prompts_match = re.search(r'\[.*\]', prompts_text, re.DOTALL)
                if prompts_match:
                    prompts = json.loads(prompts_match.group())
                    if len(prompts) >= 3:  # Ensure we have at least 3
                        return prompts
            except Exception as e:
                print(f"Could not parse recommended prompts: {e}")
        
        # Fallback prompts if LLM fails
        fallback_prompts = [
            f"What are the trends in {list(df.columns)[0]} over time?",
            f"How does {list(df.columns)[4] if len(df.columns) > 4 else 'price'} vary by category?",
            f"Show me the distribution of {list(df.columns)[5] if len(df.columns) > 5 else 'stock'}",
            f"What are the most common values in each categorical column?"
        ]
        print("Using fallback recommended prompts")
        return fallback_prompts[:4]
        
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
                result_preview = str(result.head(10))[:800]
            else:
                result_preview = str(result)[:800]
        
        error_info = ""
        if result is None:
            error_info = " (Note: Previous analysis had issues)"

        prompt = f"""As Mimir, the wise data analyst AI, provide 2-3 expert recommendations based on this analysis.

Dataset info: {list(df.columns)}
User's question: "{user_query}"
Analysis result preview: {result_preview}{error_info}

IMPORTANT: You MUST return exactly 2-3 insightful recommendations as a JSON array of strings.

Provide 2-3 recommendations that:
1. Highlight important patterns or insights discovered
2. Suggest next steps for deeper analysis  
3. Point out potential data quality issues or limitations
4. Recommend practical actions based on the findings

Be concise, professional, and helpful. Return ONLY a JSON array with exactly 2-3 strings:

["recommendation 1", "recommendation 2", "recommendation 3"]"""

        recommendations_text = call_groq(client, prompt, max_tokens=600, temperature=0.3)
        
        if recommendations_text:
            try:
                # Extract JSON array
                recs_match = re.search(r'\[.*\]', recommendations_text, re.DOTALL)
                if recs_match:
                    recommendations = json.loads(recs_match.group())
                    if len(recommendations) >= 2:  # Ensure we have at least 2
                        return recommendations
            except Exception as e:
                print(f"Could not parse Mimir recommendations: {e}")
        
        # Fallback recommendations if LLM fails
        fallback_recs = [
            "Consider analyzing data quality and missing values for more reliable insights",
            "Explore categorical variable distributions to understand data composition",
            "Check for correlations between key numeric variables"
        ]
        print("Using fallback Mimir recommendations")
        return fallback_recs[:3]
        
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
        '__import__': __import__,  # CRITICAL FIX
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
# 8. Analyze with pandas and Groq (with history context)
# =====================================================

def analyze_data(df, user_query, client, history_json=""):
    # Build context from history
    history_context = build_context_from_history(history_json)
    csv_preview = df.head(5).to_csv(index=False)
    col_info = "\n".join([f"- {col}: {df[col].dtype}" for col in df.columns])
    
    prompt = f"""You are an expert Python data analyst. Generate clean, executable pandas code to analyze dataframe `df` and accurately answer the user's question.

CONTEXT FROM PREVIOUS QUERIES:
{history_context}

STRICT RULES:
1. Output ONLY valid Python code — no explanations.
2. Always assign the final output to variable `result`.
3. If the query asks for *highest*, *lowest*, *top N*, or similar values, return **all matching rows** — not just one.
   - For example: for "highest stock", use `df[df['stock'] == df['stock'].max()]` instead of `idxmax()`.
4. If the query asks about *anomalies*, *outliers*, or *unusual values*:
   - Identify anomalies contextually, not just statistically.
   - Consider values that are extreme compared to most of the data, sudden jumps in time series, or inconsistent relationships between columns.
   - You may use z-scores, IQR, or relative deviation — but if actual obvious anomalies exist, they must be included even if z-score < 3.
   - Example approach:
     ```
     q1 = df['price'].quantile(0.25)
     q3 = df['price'].quantile(0.75)
     iqr = q3 - q1
     result = df[(df['price'] < q1 - 1.5*iqr) | (df['price'] > q3 + 1.5*iqr)]
     ```
5. Use safe, vectorized pandas operations — no loops.
6. Handle missing values and avoid breaking if a column doesn't exist.
7. The result must be a DataFrame, Series, dict, list, or scalar (never None).
8. Import numpy as np if needed.
9. No markdown fences, no text, just executable code.

CRITICAL PANDAS 2.0+ COMPATIBILITY RULES:
10. DO NOT use `include_groups=False` parameter - it was removed in pandas 2.0+
11. When using df.groupby(...).apply(...):
   - Use `group_keys=False` parameter: `df.groupby('col', group_keys=False).apply(func)`
   - OR explicitly exclude grouping columns from the operation
   - Example safe pattern:
     ```
     def analyze_group(group):
         # Work only on non-grouping columns
         return group[['price', 'stock']].mean()
     result = df.groupby('category', group_keys=False).apply(analyze_group)
     ```

12. When computing correlations per group (e.g., category, brand):
   - Only compute correlation if the group has at least 2 rows.
   - Skip or return NaN if variance in any column is zero.
   - Use this safe correlation pattern:
     ```
     # Define numeric columns to correlate
     numeric_cols = ['price', 'stock']  # Adjust based on your dataset
     
     def safe_corr(group):
         # Select only numeric columns and drop NA
         group_numeric = group[numeric_cols].dropna()
         if len(group_numeric) < 2 or group_numeric.var().eq(0).any():
             # Return NaN if not enough data
             return pd.Series({{f'corr_{{col1}}_{{col2}}': np.nan 
                             for col1 in numeric_cols for col2 in numeric_cols}})
         # Compute correlation matrix and flatten to Series
         corr_matrix = group_numeric.corr()
         # Return as flattened Series
         correlations = {{}}
         for i, col1 in enumerate(numeric_cols):
             for j, col2 in enumerate(numeric_cols):
                 if i <= j:  # Avoid duplicates
                     correlations[f'{{col1}}_{{col2}}_corr'] = corr_matrix.iloc[i, j]
         return pd.Series(correlations)
     
     result = df.groupby('category', group_keys=False).apply(safe_corr)
     ```

13. Prefer built-in aggregation methods over .apply() when possible:
   - Use `.agg()`, `.mean()`, `.sum()`, `.describe()` instead of custom apply functions
   - Example: `df.groupby('category')['price'].agg(['mean', 'std'])`

DATASET INFO:
{col_info}

PREVIEW:
{csv_preview}

USER QUESTION: {user_query}

Code only:"""

    print("Generating pandas code...")
    raw_code = call_groq(client, prompt, max_tokens=800, temperature=0.1)
    
    if not raw_code:
        print("Failed to generate code")
        return None, None, None, None, None, "Failed to generate code"

    print("\n=== Raw LLM output ===")
    print(raw_code)

    # Extract clean code
    code_clean = extract_code(raw_code)
    
    # Remove any remaining code fences
    code_clean = re.sub(r"^```[a-zA-Z]*|```$", "", code_clean.strip(), flags=re.MULTILINE).strip()

    # Apply common fixes
    if "return_counts" in code_clean:
        code_clean = code_clean.replace(".unique(return_counts=True)", ".value_counts()")
    
    # Fix groupby multiple columns without agg
    if "groupby(" in code_clean and "][" in code_clean and ".agg(" not in code_clean:
        code_clean = re.sub(
            r"\.groupby\((.*?)\)\[(.*?)\]\.(\w+)\(\)",
            r".groupby(\1)[\2].agg('\3')",
            code_clean
        )
    
    # Fix common idxmax/idxmin mistakes
    if ".idxmax()" in code_clean or ".idxmin()" in code_clean:
        if "df.loc[df[" not in code_clean and ".idxmax()]" in code_clean:
            code_clean = re.sub(
                r"result = df\.loc\[(.*?)\.idxmax\(\)\]",
                r"temp_series = \1\nresult = df.loc[temp_series.idxmax()]",
                code_clean
            )
            code_clean = re.sub(
                r"result = df\.loc\[(.*?)\.idxmin\(\)\]",
                r"temp_series = \1\nresult = df.loc[temp_series.idxmin()]",
                code_clean
            )
    
    # Fix invalid .mul() on groupby objects
    if ".groupby(" in code_clean and ".mul(" in code_clean:
        match = re.search(r"df\.groupby\('(\w+)'\)\['(\w+)'\]\.mul\(df\.groupby\('(\w+)'\)\['(\w+)'\]\)", code_clean)
        if match:
            groupby_col = match.group(1)
            col1 = match.group(2)
            col2 = match.group(4)
            replacement = f"df['{col1}'] * df['{col2}']"
            code_clean = code_clean.replace(match.group(0), replacement)
            print(f"Auto-fixed .mul() on groupby: creating calculated column first")

    # CRITICAL FIX: Remove include_groups=False from groupby().apply() calls
    if "include_groups=False" in code_clean:
        code_clean = code_clean.replace(", include_groups=False", "")
        code_clean = code_clean.replace("include_groups=False", "")
        print("Removed deprecated include_groups=False parameter")

    # Ensure group_keys=False is used for groupby().apply()
    if "groupby(" in code_clean and ".apply(" in code_clean and "group_keys=False" not in code_clean:
        code_clean = re.sub(
            r"\.groupby\((.*?)\)\.apply\((.*?)\)",
            r".groupby(\1, group_keys=False).apply(\2)",
            code_clean
        )
        print("Added group_keys=False to groupby().apply() calls")

    print("\n=== Cleaned code ===")
    print(code_clean)

    result = None
    error_msg = None
    
    if "pd.read_csv" not in code_clean and len(code_clean) > 0:
        # Use the safe execution function
        result, error_msg = safe_execute_code(code_clean, df)
        
        if result is None and error_msg:
            print(f"Error executing pandas code: {error_msg}")
            
            # Enhanced retry with specific groupby fixes
            print("\nAttempting to fix the error...")
            retry_prompt = f"""The previous code failed with this error: {error_msg}

Original question: "{user_query}"
Failed code:
{code_clean}

Generate corrected Python code that:
1. Fixes the specific error above
2. Assigns result to 'result' variable
3. Uses proper pandas syntax with pandas 2.0+ compatibility
4. For groupby operations, use `group_keys=False` but NEVER `include_groups=False`
5. Prefer built-in aggregation methods over custom apply functions
6. Ensure all variables are properly defined before use
7. Use explicit column names from the dataset instead of undefined variables

Available columns: {list(df.columns)}

Corrected code only:"""
            
            retry_code = call_groq(client, retry_prompt, max_tokens=600, temperature=0.1)
            if retry_code:
                retry_clean = extract_code(retry_code)
                retry_clean = re.sub(r"^```[a-zA-Z]*|```$", "", retry_clean.strip(), flags=re.MULTILINE).strip()
                
                # Apply the same fixes to retry code
                if "include_groups=False" in retry_clean:
                    retry_clean = retry_clean.replace(", include_groups=False", "").replace("include_groups=False", "")
                
                if "groupby(" in retry_clean and ".apply(" in retry_clean and "group_keys=False" not in retry_clean:
                    retry_clean = re.sub(
                        r"\.groupby\((.*?)\)\.apply\((.*?)\)",
                        r".groupby(\1, group_keys=False).apply(\2)",
                        retry_clean
                    )
                
                print("\n=== Retry code ===")
                print(retry_clean)
                
                # Execute retry code safely
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
                print(result.head(20).to_string())
            else:
                print(str(result)[:2000])  # Limit output length
    else:
        print("No executable code detected; treating as descriptive query.")
        error_msg = "No executable code generated"

    # Build friendly summary - ALWAYS generate this
    result_preview = ""
    if result is not None:
        if hasattr(result, 'head'):
            result_preview = result.head(10).to_string()[:1500]
        else:
            result_preview = str(result)[:1500]
    elif error_msg:
        result_preview = f"Analysis encountered an error: {error_msg}"
    else:
        result_preview = "No analysis result available"

    result_preview = re.sub(r'[^\x20-\x7E]+', ' ', str(result_preview))

    prompt_summary = f"""You are a concise, professional data analyst explaining analysis results.

User question: "{user_query}"
Analysis result: {result_preview}

Provide a clear, factual explanation of what the result means.
If multiple values or categories are relevant, mention them all.
If anomalies, outliers, or unusual patterns are present, describe them clearly and explain why they stand out.
Avoid guessing — summarize only what is observable in the data.
Keep the tone friendly but precise.

Response:"""

    human_text = call_groq(client, prompt_summary, max_tokens=400, temperature=0.7)

    if human_text:
        print("\n=== Analysis Summary ===")
        print(human_text)
    else:
        human_text = "I analyzed your data but couldn't generate a summary. Please check the raw results above."
        print("\n=== Analysis Summary ===")
        print(human_text)

    # ALWAYS generate recommended prompts and Mimir recommendations
    print("\n=== Generating Insights ===")
    recommended_prompts = generate_recommended_prompts(df, user_query, result, client)
    mimir_recommends = generate_mimir_recommends(df, user_query, result, client)

    # Intelligently decide if chart is needed
    should_chart = False
    if result is not None and not error_msg:
        # Check if result is chartable
        has_table_data = isinstance(result, (pd.DataFrame, pd.Series, list, dict))
        is_numeric = isinstance(result, (int, float))
        
        if has_table_data or is_numeric:
            # Quick decision: does this query benefit from visualization?
            viz_keywords = ['compare', 'trend', 'distribution', 'over time', 'by category', 
                           'chart', 'graph', 'plot', 'visualize', 'show', 'display']
            
            query_lower = user_query.lower()
            
            # Check if query suggests visualization
            wants_viz = any(keyword in query_lower for keyword in viz_keywords)
            
            # Check if result type is chart-friendly
            is_chartable = False
            if isinstance(result, pd.DataFrame):
                # Good for charts if it has 2-50 rows and numeric columns
                is_chartable = 2 <= len(result) <= 50 and any(result.dtypes.apply(lambda x: x.kind in 'biufc'))
            elif isinstance(result, pd.Series):
                # Good for charts if it has 2-20 items
                is_chartable = 2 <= len(result) <= 20
            elif isinstance(result, dict):
                is_chartable = 2 <= len(result) <= 20
            
            should_chart = wants_viz or is_chartable
        
    # Generate chart JSON only if appropriate
    chart_json = None
    if should_chart:
        # Convert result to dict for chart generation
        if isinstance(result, pd.DataFrame):
            chart_data = result.to_dict('records')
        elif isinstance(result, pd.Series):
            chart_data = result.to_dict()
        else:
            chart_data = result

        prompt_chart = f"""
You are a data visualization expert.

User question: "{user_query}"
Analysis result preview: {result_preview}

Data: {str(chart_data)[:1000]}

Instructions:
1. ONLY generate a chart if it makes sense for the data.
   - If the question is about relationships between fields (correlations, comparisons), include both/all relevant fields.
   - If the data has multiple numeric columns, show them together if meaningful.
   - If there's no meaningful comparison, do NOT generate a chart.

2. Choose the most suitable chart type:
   - Scatter: correlations or relationships between numeric columns.
   - Line/area: trends over time.
   - Bar/column: comparison across categories.
   - Boxplot: distributions or anomaly detection.
   - Pie/donut: proportions (only if meaningful).

3. If the question is about anomalies or outliers:
   - Highlight the unusual values (e.g., red points on scatter, outliers on boxplot).

4. Include axis labels, legend, and descriptive title.
5. Scale numbers or annotate when values are very small/very large.
6. If multiple numeric columns are relevant, include them together.
7. Return only a valid ECharts JSON object (no commentary, no markdown).

Output: JSON only.
"""

        chart_text = call_groq(client, prompt_chart, max_tokens=800, temperature=0.3)
        
        if chart_text:
            chart_text = re.sub(r"^```[a-zA-Z]*|```$", "", chart_text.strip(), flags=re.MULTILINE).strip()

            try:
                json.loads(chart_text)
                chart_json = chart_text
                print("\n=== ECharts JSON ===")
                print(chart_json)
            except Exception:
                print("\nChart generation skipped (invalid JSON)")

    return human_text, recommended_prompts, mimir_recommends, chart_json, result, error_msg


# =====================================================
# 9. Entry point - WINDOWS COMPATIBLE OUTPUT FORMAT
# =====================================================

if __name__ == "__main__":
    if len(sys.argv) < 4:
        print("Usage: python analyzer.py <csv_path> <query> <history_json>")
        sys.exit(1)
    
    csv_path = sys.argv[1]
    query = sys.argv[2]
    history_json = sys.argv[3]  # Get history as 3rd argument
    
    try:
        client = load_groq_client()
        df = load_clean_csv(csv_path)
        summary, recommended_prompts, mimir_recommends, chart, result, error = analyze_data(df, query, client, history_json)
        
        # CRITICAL FIX: Use consistent section markers that work on both Windows and Linux
        # Print each section with clear, unique markers that are easy to parse
        
        # 1. Analysis Summary
        print("\n=== ANALYSIS_SUMMARY_START ===")
        print(summary if summary else "No summary available")
        print("=== ANALYSIS_SUMMARY_END ===")
        
        # 2. Recommended Prompts (ALWAYS provide JSON array)
        print("\n=== RECOMMENDED_PROMPTS_START ===")
        prompts_json = json.dumps(recommended_prompts if recommended_prompts else [])
        print(prompts_json)
        print("=== RECOMMENDED_PROMPTS_END ===")
        
        # 3. Mimir Recommends (ALWAYS provide JSON array)  
        print("\n=== MIMIR_RECOMMENDS_START ===")
        mimir_json = json.dumps(mimir_recommends if mimir_recommends else [])
        print(mimir_json)
        print("=== MIMIR_RECOMMENDS_END ===")
        
        # 4. Chart data (if available)
        if chart:
            print("\n=== CHART_DATA_START ===")
            print(chart)
            print("=== CHART_DATA_END ===")
        else:
            print("\n=== CHART_DATA_START ===")
            print("null")
            print("=== CHART_DATA_END ===")
            
        # 5. Error info (if any)
        if error:
            print("\n=== ERROR_INFO_START ===")
            print(error)
            print("=== ERROR_INFO_END ===")
            
    except Exception as e:
        print(f"Fatal error in analyzer: {e}")
        # Even on fatal error, provide the expected JSON sections
        print("\n=== ANALYSIS_SUMMARY_START ===")
        print(f"Error: {e}")
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
