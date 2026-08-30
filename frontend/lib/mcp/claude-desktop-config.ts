export const DEFAULT_MCP_SERVER_URL = "http://localhost:8080/mcp";

type ClaudeDesktopServerConfig = {
  command: "npx";
  args: string[];
  env: {
    PERSONAL_PORTFOLIO_AUTH_HEADER: string;
  };
};

export type ClaudeDesktopMcpConfig = {
  mcpServers: {
    "personal-portfolio": ClaudeDesktopServerConfig;
  };
};

function resolveMcpServerUrl(mcpUrl?: string): string {
  const trimmed = mcpUrl?.trim();
  if (!trimmed) {
    return DEFAULT_MCP_SERVER_URL;
  }
  return trimmed;
}

export function buildClaudeDesktopMcpConfig(
  apiKey: string,
  mcpUrl?: string
): ClaudeDesktopMcpConfig {
  const resolvedMcpUrl = resolveMcpServerUrl(mcpUrl);
  const args = [
    "-y",
    "mcp-remote@latest",
    resolvedMcpUrl,
    "--transport",
    "http-only",
    "--header",
    "Authorization:${PERSONAL_PORTFOLIO_AUTH_HEADER}",
  ];

  if (resolvedMcpUrl.toLowerCase().startsWith("http://")) {
    args.push("--allow-http");
  }

  return {
    mcpServers: {
      "personal-portfolio": {
        command: "npx",
        args,
        env: {
          PERSONAL_PORTFOLIO_AUTH_HEADER: `Bearer ${apiKey}`,
        },
      },
    },
  };
}

export function stringifyClaudeDesktopMcpConfig(
  apiKey: string,
  mcpUrl?: string
): string {
  return JSON.stringify(buildClaudeDesktopMcpConfig(apiKey, mcpUrl), null, 2);
}
