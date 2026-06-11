Read a webpage's full content as clean markdown. Use after web_search when highlights are insufficient or to read any known URL.

Best for: Extracting full content from known URLs. Batch multiple URLs in one call.
Returns: Clean text content and metadata from the page(s).

Usage notes:
  - The URL must be a fully-formed valid URL
  - HTTP URLs will be automatically upgraded to HTTPS
  - Format options: "markdown" (default), "text", or "html"
  - This tool is read-only and does not modify any files
  - Results may be summarized if the content is very large. Use `Read` tool on large result files for full content.
