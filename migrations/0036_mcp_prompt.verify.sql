SELECT '0036_mcp_prompt_table' AS assertion, COUNT(*) = 1 AS pass FROM sqlite_master WHERE type='table' AND name='mcp_prompt';
SELECT '0036_mcp_prompt_row' AS assertion, COUNT(*) = 1 AS pass FROM mcp_prompt WHERE id='system';
SELECT '0036_mcp_prompt_valid' AS assertion, COUNT(*) = 0 AS pass FROM mcp_prompt WHERE prompt_template IS NOT NULL AND (length(prompt_template) NOT BETWEEN 1 AND 8000 OR instr(prompt_template, '{{endpoint}}') = 0);
SELECT '0036_mcp_prompt_registered' AS assertion, COUNT(*) = 1 AS pass FROM d1_migrations WHERE name='0036_mcp_prompt.sql';
