"""Native MCP identity helper.

The MCP process is an internal service. Its database role is scoped by the
PostgreSQL connection and its writes are attributed to the configured Better
Auth user id; no external JWT is created or accepted.
"""
from __future__ import annotations
from dataclasses import dataclass
from verity_dam_mcp.settings import McpSettings

@dataclass
class BotSession:
    settings: McpSettings
    def invalidate(self) -> None: return None
    def get_user_id(self) -> str | None: return self.settings.bot_user_id
