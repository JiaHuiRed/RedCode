"""
RedNote MCP Server – Python implementation.

Tools:
  1.  login              – QR-code authentication
  2.  set_browser_mode   – Toggle headless/headed browser (use headed when bot detected)
  3.  search_notes       – Search notes by keyword
  4.  get_note_details   – Full note body + top-level comments (fast, token-light)
  5.  get_user_profile   – User stats + recent posts
  6.  post_note          – Publish a new note (picture + text) on the creator platform
"""

from __future__ import annotations

import json
from typing import Any

from mcp.server.fastmcp import FastMCP

from rednote_mcp.auth.auth_manager import (
    login as _do_login,
    get_persistent_context,
    reset_persistent_context,
    set_browser_headless as _set_browser_headless,
)
from rednote_mcp.tools.rednote_tools import (
    get_note_details as _get_note_details,
    post_note as _post_note,
    search_notes as _search_notes,
)
from rednote_mcp.tools.user_profile import get_user_profile as _get_user_profile
from rednote_mcp.utils.logger import get_logger

logger = get_logger(__name__)

mcp = FastMCP(
    "rednote",
    instructions="RedNote (小红书/XiaoHongShu) MCP server",
)


# ---------------------------------------------------------------------------
# Serialization helper
# ---------------------------------------------------------------------------

def _json(obj: Any) -> str:
    if hasattr(obj, "to_dict"):
        return json.dumps(obj.to_dict(), ensure_ascii=False, indent=2)
    if isinstance(obj, list):
        return json.dumps(
            [x.to_dict() if hasattr(x, "to_dict") else x for x in obj],
            ensure_ascii=False,
            indent=2,
        )
    return json.dumps(obj, ensure_ascii=False, indent=2)


# ---------------------------------------------------------------------------
# Tool 1 – login
# ---------------------------------------------------------------------------

@mcp.tool()
async def login(timeout_seconds: int = 60, force: bool = False) -> str:
    """
    Authenticate with XiaoHongShu by scanning a QR code in a visible browser window.
    Must be called once before using any other tool. Cookies are persisted to disk
    and reused automatically on subsequent tool calls.
    Use force=True when bot detection is triggered — it clears the existing session
    and starts a completely fresh one.

    Input:
        timeout_seconds (int, default 60): Seconds to wait for the user to scan the QR code.
        force           (bool, default False): If True, clears existing cookies before login
                        to generate a brand-new session. Use this when bot detection is triggered.

    Output (str):
        "Login successful. Cookies have been saved." on success, or an error message.
    """
    logger.info("Tool: login (timeout=%ds, force=%s)", timeout_seconds, force)
    success = await _do_login(timeout_seconds=timeout_seconds, force=force)
    if success:
        return "Login successful. Cookies have been saved."
    return "Login failed after multiple attempts. Please try again."


# ---------------------------------------------------------------------------
# Tool 2 – set_browser_mode
# ---------------------------------------------------------------------------

@mcp.tool()
def set_browser_mode(headless: bool) -> str:
    """
    Control whether the browser runs headless (invisible) or headed (visible window).
    By default all tools run headless. Switch to headed mode (headless=False) when
    bot detection or CAPTCHA is blocking requests — the visible browser lets the user
    see and dismiss any challenge before the tool retries. Switch back to headless=True
    after the issue is resolved to avoid unnecessary browser windows.

    A key symptom of bot detection is that tools return empty results (empty lists,
    empty strings, or objects with all-blank fields) even for valid inputs. If this
    happens, call set_browser_mode(headless=False) then retry the tool.

    Input:
        headless (bool): True = invisible background browser (default, normal operation).
                         False = visible browser window (use when bot detection is triggered,
                         indicated by tools returning empty results).

    Output (str): Confirmation of the new mode.
    """
    import asyncio
    _set_browser_headless(headless)
    asyncio.get_event_loop().create_task(reset_persistent_context())
    mode = "headless (invisible)" if headless else "headed (visible window)"
    logger.info("Tool: set_browser_mode headless=%s", headless)
    return f"Browser mode set to {mode}. Existing session will be restarted on next tool call."


# ---------------------------------------------------------------------------
# Tool 3 – search_notes
# ---------------------------------------------------------------------------

@mcp.tool()
async def search_notes(keyword: str, limit: int = 3) -> str:
    """
    Search XiaoHongShu for notes matching a keyword.

    Input:
        keyword (str): Search term in Chinese or English.
        limit   (int, default 3): Number of notes to return.

    Output (JSON array of objects):
        [
          {
            "title":       str,   // note title
            "author":      str,   // display name of the author
            "content":     str,   // body text (may be truncated)
            "tags":        [str], // hashtags found in the content
            "url":         str,   // full xiaohongshu.com note URL
            "likes":       int,
            "collects":    int,
            "comments":    int,
            "note_id":     str,   // use with get_note_details
            "xsec_token":  str    // use with get_note_details
          },
          ...
        ]
    """
    logger.info("Tool: search_notes keyword='%s' limit=%d", keyword, limit)
    browser, context = await get_persistent_context()
    notes = await _search_notes(context, keyword, limit=limit)
    return _json(notes)


# ---------------------------------------------------------------------------
# Tool 4 – get_note_details
# ---------------------------------------------------------------------------

@mcp.tool()
async def get_note_details(note_id: str, xsec_token: str, top_comments_limit: int = 10) -> str:
    """
    Fetch the full body of a note and its top-level comments. Does not expand
    nested reply threads. Use this as the default way to read a note.

    Input:
        note_id            (str): Note ID from search_notes or get_community_trending results.
        xsec_token         (str): Access token from search_notes or get_community_trending results.
        top_comments_limit (int, default 10): Max top-level comments to include.

    Output (JSON object):
        {
          "title":    str,
          "content":  str,
          "tags":     [str],
          "imgs":     [str],   // image URLs
          "videos":   [str],   // video stream URLs (empty for image notes)
          "url":      str,
          "author":   str,
          "author_id":         str,  // user ID, use with get_user_profile
          "author_xsec_token": str,  // token for get_user_profile
          "likes":    int,
          "collects": int,
          "comments_count": int,
          "top_level_comments": [
            { "author": str, "content": str, "likes": int },
            ...
          ]
        }
    """
    logger.info("Tool: get_note_details note_id='%s'", note_id)
    browser, context = await get_persistent_context()
    result = await _get_note_details(context, note_id, xsec_token, top_comments_limit)
    return _json(result)


# ---------------------------------------------------------------------------
# Tool 5 – get_user_profile
# ---------------------------------------------------------------------------

@mcp.tool()
async def get_user_profile(user_id: str, xsec_token: str = "", recent_posts_limit: int = 3) -> str:
    """
    Fetch the public profile of a XiaoHongShu user. Pass author_id and
    author_xsec_token from get_note_details directly as user_id and xsec_token here.

    Input:
        user_id            (str): Bare user ID from get_note_details author_id field.
        xsec_token         (str, optional): Token from get_note_details author_xsec_token field.
                           Providing it builds a properly authenticated URL (recommended).
        recent_posts_limit (int, default 3): Max recent posts to include.

    Output (JSON object):
        {
          "user_id":      str,
          "username":     str,
          "bio":          str,
          "followers":    int,
          "following":    int,
          "total_likes":  int,
          "profile_url":  str,
          "recent_posts": [
            { "title": str, "url": str, "cover_img": str, "likes": int },
            ...
          ]
        }
    """
    logger.info("Tool: get_user_profile id='%s'", user_id)
    browser, context = await get_persistent_context()
    result = await _get_user_profile(context, user_id, xsec_token, recent_posts_limit)
    return _json(result)


# ---------------------------------------------------------------------------
# Tool 6 – post_note
# ---------------------------------------------------------------------------

@mcp.tool()
async def post_note(
    title: str,
    content: str,
    image_paths: list[str],
    tags: list[str] | None = None,
) -> str:
    """
    Publish a new note on XiaoHongShu via the creator platform.
    This tool posts a picture-and-text note — at least one image and text content are required.

    Input:
        title       (str): Note title (required).
                    - Must not exceed 20 characters.
        content     (str): Note body text (required).
                    - Must not exceed 1000 characters.
        image_paths (list[str]): Local file paths of images to upload (required).
                    - Must contain at least 1 image.
                    - Must not exceed 18 images.
                    - Must be files on the local machine — URLs are not supported.
                    - Supports jpg, jpeg, png, webp. Tilde (~) paths are accepted.
        tags        (list[str], optional): Hashtags to append, with or without leading '#'.

    Output (JSON object):
        { "success": true }
        { "success": false, "errors": [str, ...] }   – validation failures
        { "success": false, "error": str }            – runtime failure
    """
    logger.info("Tool: post_note title='%s'", title)
    browser, context = await get_persistent_context()
    result = await _post_note(
        context, title=title, content=content,
        image_paths=image_paths, tags=tags,
    )
    return _json(result)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
