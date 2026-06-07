import asyncio
import random
import re
from math import log
from random import lognormvariate
from dataclasses import dataclass, asdict, field

from playwright.async_api import Page

from rednote_mcp.utils.logger import get_logger

logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _parse_count(text: str) -> int:
    """Convert display counts like '1.2万' to integers."""
    if not text:
        return 0
    text = text.strip()
    try:
        if "万" in text:
            return int(float(text.replace("万", "")) * 10_000)
        return int(text)
    except ValueError:
        return 0


async def _random_delay(avg: float = 6.0, sigma: float = 0.6) -> None:
    """Lognormally-distributed delay matching xhs-downloader's timing."""
    mu = log(avg) - (sigma ** 2 / 2)
    await asyncio.sleep(max(0.5, lognormvariate(mu, sigma)))


async def _el_text(el, selector: str) -> str:
    """Query selector within an element handle and return inner text."""
    try:
        child = await el.query_selector(selector)
        return (await child.inner_text()).strip() if child else ""
    except Exception:
        return ""


# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------

@dataclass
class NoteDetail:
    title: str = ""
    content: str = ""
    tags: list[str] = field(default_factory=list)
    imgs: list[str] = field(default_factory=list)
    videos: list[str] = field(default_factory=list)
    url: str = ""
    author: str = ""
    likes: int = 0
    collects: int = 0
    comments: int = 0

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class TopLevelComment:
    author: str = ""
    content: str = ""
    likes: int = 0

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class NoteWithComments:
    """Combined result for get_note_details (fast path)."""
    title: str = ""
    content: str = ""
    tags: list[str] = field(default_factory=list)
    imgs: list[str] = field(default_factory=list)
    videos: list[str] = field(default_factory=list)
    url: str = ""
    author: str = ""
    author_id: str = ""
    author_xsec_token: str = ""
    likes: int = 0
    collects: int = 0
    comments_count: int = 0
    top_level_comments: list[TopLevelComment] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


# ---------------------------------------------------------------------------
# Note body extraction — prefers window.__INITIAL_STATE__ (single JS eval,
# fewer DOM queries, much less detectable) with DOM fallback.
# Approach ported from xhs-downloader's Converter.
# ---------------------------------------------------------------------------

_EXTRACT_INITIAL_STATE_JS = """
() => {
    try {
        const state = window.__INITIAL_STATE__;
        if (!state) return null;
        const map = state.noteDetailMap || state.note?.noteDetailMap;
        if (!map) return null;
        const key = Object.keys(map)[Object.keys(map).length - 1];
        const entry = map[key];
        const note = entry?.note;
        if (!note) return null;

        // Images
        const imgs = [];
        if (note.imageList) {
            for (const img of note.imageList) {
                const url = img.urlDefault || img.url;
                if (url) imgs.push(url.startsWith('http') ? url : 'https:' + url);
            }
        }

        // Videos
        const videos = [];
        const streams = note.video?.media?.stream;
        if (streams) {
            for (const codec of ['h264', 'H264', 'h265', 'H265']) {
                const list = streams[codec];
                if (list && list.length > 0 && list[0].masterUrl) {
                    videos.push(list[0].masterUrl);
                    break;
                }
            }
        }

        // Tags
        const tags = [];
        if (note.tagList) {
            for (const t of note.tagList) {
                if (t.name) tags.push('#' + t.name);
            }
        }

        return {
            title: note.title || '',
            desc: note.desc || '',
            tags: tags,
            imgs: imgs,
            videos: videos,
            type: note.type || '',
            author: note.user?.nickname || note.user?.nickName || '',
            authorId: note.user?.userId || '',
            likedCount: note.interactInfo?.likedCount || 0,
            collectedCount: note.interactInfo?.collectedCount || 0,
            commentCount: note.interactInfo?.commentCount || 0,
            shareCount: note.interactInfo?.shareCount || 0,
        };
    } catch(e) {
        return null;
    }
}
"""


async def extract_note_detail(page: Page, url: str) -> NoteDetail:
    detail = NoteDetail(url=url)

    try:
        await page.wait_for_selector(".note-container", timeout=10_000)
    except Exception:
        logger.warning("Timed out waiting for note container at %s", url)

    # ---- Primary path: extract everything from __INITIAL_STATE__ ----
    try:
        state = await page.evaluate(_EXTRACT_INITIAL_STATE_JS)
    except Exception:
        state = None

    if state:
        detail.title = state.get("title", "")
        detail.content = state.get("desc", "")
        detail.tags = state.get("tags", [])
        detail.imgs = state.get("imgs", [])
        detail.videos = state.get("videos", [])
        detail.author = state.get("author", "")
        detail.likes = state.get("likedCount", 0)
        detail.collects = state.get("collectedCount", 0)
        detail.comments = state.get("commentCount", 0)
        logger.info("Extracted note detail from __INITIAL_STATE__")
        return detail

    # ---- Fallback: DOM scraping (more detectable, but works if state is missing) ----
    logger.info("__INITIAL_STATE__ unavailable, falling back to DOM scraping")

    for media_sel in (".media-container", ".video-container", "xg-player", ".note-video", "video"):
        try:
            await page.wait_for_selector(media_sel, timeout=3_000)
            break
        except Exception:
            pass

    async def text(selector: str, fallback: str = "") -> str:
        try:
            el = await page.query_selector(selector)
            return (await el.inner_text()).strip() if el else fallback
        except Exception:
            return fallback

    detail.title = await text("#detail-title") or await text(".title")

    content_parts = []
    for el in await page.query_selector_all(
        ".note-scroller .note-content .note-text span"
    ):
        try:
            content_parts.append((await el.inner_text()).strip())
        except Exception:
            pass
    detail.content = "\n".join(p for p in content_parts if p)

    for a in await page.query_selector_all(
        ".note-scroller .note-content .note-text a"
    ):
        try:
            tag = (await a.inner_text()).strip()
            if tag.startswith("#"):
                detail.tags.append(tag)
        except Exception:
            pass

    detail.author = await text(".author-container .info .username")

    detail.likes = _parse_count(await text(".interact-container .like-wrapper .count"))
    detail.collects = _parse_count(await text(".interact-container .collect-wrapper .count"))
    detail.comments = _parse_count(await text(".interact-container .chat-wrapper .count"))

    for img in await page.query_selector_all(
        ".media-container img, .note-slider img, .swiper-slide img"
    ):
        try:
            src = await img.get_attribute("src")
            if src and not src.startswith("data:"):
                detail.imgs.append(src)
        except Exception:
            pass

    # Video fallback from __INITIAL_STATE__ (already tried above, but try again for video-only)
    try:
        js_video_url = await page.evaluate("""
            () => {
                try {
                    const state = window.__INITIAL_STATE__;
                    if (!state) return null;
                    const map = state.noteDetailMap || state.note?.noteDetailMap;
                    if (!map) return null;
                    for (const key of Object.keys(map)) {
                        const note = map[key];
                        const streams = note?.note?.video?.media?.stream;
                        if (streams) {
                            for (const codec of ['h264', 'H264', 'h265', 'H265']) {
                                const list = streams[codec];
                                if (list && list.length > 0 && list[0].masterUrl) return list[0].masterUrl;
                            }
                        }
                    }
                } catch(e) {}
                return null;
            }
        """)
        if js_video_url:
            detail.videos.append(js_video_url)
    except Exception:
        pass

    return detail


# ---------------------------------------------------------------------------
# Comment extraction — fast path (no reply expansion)
# ---------------------------------------------------------------------------

_COMMENT_CONTAINER = ".comments-container, .comment-list, [class*='comment-list']"
_COMMENT_ITEM = ".comment-item, [class*='comment-item']"


async def extract_top_level_comments(page: Page, limit: int = 20) -> list[TopLevelComment]:
    """
    Fast path: extract top-level comments without clicking reply-expand buttons.
    `reply_count` is populated from the button label; `replies` arrays are empty.
    """
    comments: list[TopLevelComment] = []
    try:
        await page.wait_for_selector(_COMMENT_CONTAINER, timeout=8_000)
    except Exception:
        logger.warning("Comment container not found")
        return comments

    items = await page.query_selector_all(_COMMENT_ITEM)
    for item in items[:limit]:
        c = TopLevelComment()
        try:
            c.author = (
                await _el_text(item, ".author-name")
                or await _el_text(item, ".user-info .name")
                or await _el_text(item, ".name")
            )
            c.content = (
                await _el_text(item, ".content span")
                or await _el_text(item, ".comment-content")
                or await _el_text(item, "p")
            )
            c.likes = _parse_count(
                await _el_text(item, ".like-wrapper .count")
                or await _el_text(item, ".like-count")
            )
            comments.append(c)
        except Exception as e:
            logger.warning("Error extracting comment: %s", e)

    return comments


