/**
 * VerityDAM MCP catalog: tool list, minimum roles and client config snippets.
 *
 * Tool names/minRole must match backend/verity_dam_mcp/governance.py
 * TOOL_MIN_ROLE (checked by backend/tests/test_mcp_governance.py).
 */

export type McpAgentRole = 'viewer' | 'contributor' | 'reviewer';

export interface McpToolInfo {
  name: string;
  title: string;
  desc: string;
  minRole: McpAgentRole;
  access: 'read' | 'write';
}

export const MCP_TOOLS: readonly McpToolInfo[] = [
  {
    name: 'media_search',
    title: 'Tìm ảnh bằng ngôn ngữ tự nhiên',
    desc: 'Tìm ảnh bằng câu tiếng Việt/Anh, loại trừ ảnh đang bị báo lỗi.',
    minRole: 'viewer',
    access: 'read',
  },
  {
    name: 'media_list_library',
    title: 'Duyệt thư viện',
    desc: 'Liệt kê và lọc ảnh đã duyệt theo bộ lọc chính xác.',
    minRole: 'viewer',
    access: 'read',
  },
  {
    name: 'media_search_by_image',
    title: 'Tìm ảnh tương tự',
    desc: 'Tìm ảnh giống về hình ảnh (vector similarity) từ asset có sẵn hoặc ảnh base64.',
    minRole: 'viewer',
    access: 'read',
  },
  {
    name: 'media_get_asset',
    title: 'Xem chi tiết asset',
    desc: 'Metadata, crop, kích thước và link CDN của một asset (asset chưa duyệt cần reviewer).',
    minRole: 'viewer',
    access: 'read',
  },
  {
    name: 'media_evaluate_image_fit',
    title: 'Đánh giá ảnh cho bài viết',
    desc: 'Chấm độ phù hợp của ảnh với bài viết (0-3), tỷ lệ khung hình, tránh lặp ảnh.',
    minRole: 'viewer',
    access: 'read',
  },
  {
    name: 'media_find_best_image_for_post',
    title: 'Chọn ảnh tốt nhất cho bài đăng',
    desc: 'Tìm và xếp hạng ảnh phù hợp nhất cho bài đăng theo kênh.',
    minRole: 'viewer',
    access: 'read',
  },
  {
    name: 'media_get_usage_history',
    title: 'Lịch sử sử dụng ảnh',
    desc: 'Tra cứu ảnh đã được đăng lên kênh nào và bao nhiêu lần.',
    minRole: 'viewer',
    access: 'read',
  },
  {
    name: 'media_upload_asset',
    title: 'Upload ảnh chờ duyệt',
    desc: 'Tải ảnh mới (base64) vào hàng chờ duyệt; không tự duyệt.',
    minRole: 'contributor',
    access: 'write',
  },
  {
    name: 'media_record_usage',
    title: 'Ghi nhận đăng ảnh',
    desc: 'Ghi lại việc ảnh đã được đăng lên một kênh (Facebook, Zalo, Website…).',
    minRole: 'contributor',
    access: 'write',
  },
  {
    name: 'media_list_pending_review',
    title: 'Xem hàng chờ duyệt',
    desc: 'Liệt kê ảnh chờ duyệt kèm metadata AI đề xuất và cờ trùng lặp.',
    minRole: 'reviewer',
    access: 'read',
  },
  {
    name: 'media_resolve_review_item',
    title: 'Duyệt / từ chối ảnh',
    desc: 'Duyệt hoặc từ chối ảnh trong hàng chờ, có thể sửa metadata khi duyệt.',
    minRole: 'reviewer',
    access: 'write',
  },
  {
    name: 'media_update_metadata',
    title: 'Sửa metadata',
    desc: 'Cập nhật caption, nhãn, không gian, bản quyền cho asset đã duyệt.',
    minRole: 'reviewer',
    access: 'write',
  },
  {
    name: 'media_save_crop',
    title: 'Lưu vùng crop',
    desc: 'Lưu toạ độ crop theo tỷ lệ chuẩn (1:1, 16:9, 9:16, 4:5, tự do).',
    minRole: 'reviewer',
    access: 'write',
  },
];

const ROLE_RANK: Record<McpAgentRole, number> = { viewer: 0, contributor: 1, reviewer: 2 };

export function toolsForRole(role: McpAgentRole): McpToolInfo[] {
  return MCP_TOOLS.filter((tool) => ROLE_RANK[role] >= ROLE_RANK[tool.minRole]);
}

export const MCP_TOKEN_PLACEHOLDER = 'verity_mcp_live_YOUR_API_KEY';
export const MCP_SERVER_NAME = 'verity-dam';

export type McpClientId = 'generic' | 'claude-desktop' | 'claude-code' | 'cursor' | 'vscode';

export interface McpClientConfig {
  id: McpClientId;
  label: string;
  filename: string;
  language: 'json' | 'shell';
  code: string;
  note: string;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function mcpClientConfigs(endpoint: string, token: string = MCP_TOKEN_PLACEHOLDER): McpClientConfig[] {
  const authorization = `Bearer ${token}`;
  return [
    {
      id: 'generic',
      label: 'Agenthub / Dify / Antigravity',
      filename: 'agent-mcp.json',
      language: 'json',
      code: json({ name: MCP_SERVER_NAME, transport: 'streamable-http', url: endpoint, headers: { Authorization: authorization } }),
      note: 'Dạng chung cho client hỗ trợ Streamable HTTP với header tùy chỉnh.',
    },
    {
      id: 'claude-desktop',
      label: 'Claude Desktop',
      filename: 'claude_desktop_config.json',
      language: 'json',
      code: json({
        mcpServers: {
          [MCP_SERVER_NAME]: {
            command: 'npx',
            args: ['-y', 'mcp-remote', endpoint, '--header', 'Authorization:${VERITY_MCP_AUTH}'],
            env: { VERITY_MCP_AUTH: authorization },
          },
        },
      }),
      note: 'File cấu hình của Claude Desktop chỉ chạy server qua lệnh, nên dùng cầu nối mcp-remote (cần Node.js). Token nằm trong env để tránh lỗi dấu cách trong args trên Windows.',
    },
    {
      id: 'claude-code',
      label: 'Claude Code',
      filename: 'terminal',
      language: 'shell',
      code: `claude mcp add --transport http ${MCP_SERVER_NAME} ${endpoint} --header "Authorization: ${authorization}"`,
      note: 'Chạy một lần trong terminal; kiểm tra bằng `claude mcp list`.',
    },
    {
      id: 'cursor',
      label: 'Cursor',
      filename: '.cursor/mcp.json',
      language: 'json',
      code: json({ mcpServers: { [MCP_SERVER_NAME]: { url: endpoint, headers: { Authorization: authorization } } } }),
      note: 'Đặt trong project (.cursor/mcp.json) hoặc ~/.cursor/mcp.json cho mọi project.',
    },
    {
      id: 'vscode',
      label: 'VS Code',
      filename: '.vscode/mcp.json',
      language: 'json',
      code: json({ servers: { [MCP_SERVER_NAME]: { type: 'http', url: endpoint, headers: { Authorization: authorization } } } }),
      note: 'VS Code (Copilot agent mode) đọc .vscode/mcp.json trong workspace.',
    },
  ];
}

/**
 * OAuth connection: only the URL. The client discovers the authorization
 * server from the MCP 401 challenge, registers itself and opens the VerityDAM
 * login + consent page; the agent then acts with the signed-in user's role.
 */
export function mcpOAuthConfigs(endpoint: string): McpClientConfig[] {
  return [
    {
      id: 'claude-desktop',
      label: 'Claude (web / Desktop)',
      filename: 'Settings → Connectors → Add custom connector',
      language: 'shell',
      code: endpoint,
      note: 'Dán URL vào ô "Remote MCP server URL", bấm Connect rồi đăng nhập VerityDAM và bấm Cho phép. Không cần API key hay Node.js.',
    },
    {
      id: 'claude-code',
      label: 'Claude Code',
      filename: 'terminal',
      language: 'shell',
      code: `claude mcp add --transport http ${MCP_SERVER_NAME} ${endpoint}`,
      note: 'Sau đó gõ /mcp trong Claude Code và chọn Authenticate để mở trang đăng nhập.',
    },
    {
      id: 'cursor',
      label: 'Cursor',
      filename: '.cursor/mcp.json',
      language: 'json',
      code: json({ mcpServers: { [MCP_SERVER_NAME]: { url: endpoint } } }),
      note: 'Không có header Authorization: Cursor tự mở trình duyệt để đăng nhập khi kết nối.',
    },
    {
      id: 'vscode',
      label: 'VS Code',
      filename: '.vscode/mcp.json',
      language: 'json',
      code: json({ servers: { [MCP_SERVER_NAME]: { type: 'http', url: endpoint } } }),
      note: 'VS Code hiện nút đăng nhập khi khởi động server lần đầu.',
    },
  ];
}

function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

/** One-click install links. Only meaningful with a real token. */
export function mcpInstallLinks(endpoint: string, token: string): { cursor: string; vscode: string } {
  const headers = { Authorization: `Bearer ${token}` };
  const cursorConfig = base64Utf8(JSON.stringify({ url: endpoint, headers }));
  const vscodeConfig = JSON.stringify({ name: MCP_SERVER_NAME, type: 'http', url: endpoint, headers });
  return {
    cursor: `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(MCP_SERVER_NAME)}&config=${encodeURIComponent(cursorConfig)}`,
    vscode: `vscode:mcp/install?${encodeURIComponent(vscodeConfig)}`,
  };
}

export const MCP_SAMPLE_PROMPTS: readonly { role: McpAgentRole; text: string }[] = [
  { role: 'viewer', text: 'Tìm 5 ảnh hộp đựng thực phẩm LocknLock đã duyệt, có thể dùng cho bài Facebook về bảo quản đồ ăn trong tủ lạnh. Trả về link CDN và lý do chọn.' },
  { role: 'viewer', text: 'Đọc bài viết sau và chọn ảnh phù hợp nhất cho kênh Zalo, tránh ảnh đã đăng trong 30 ngày gần đây: <dán bài viết>' },
  { role: 'reviewer', text: 'Liệt kê 10 ảnh đang chờ duyệt có cờ trùng lặp, tóm tắt metadata AI đề xuất cho từng ảnh. Chưa duyệt ảnh nào.' },
];
