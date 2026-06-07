from __future__ import annotations

from dataclasses import dataclass, asdict, field

from playwright.async_api import BrowserContext, Page

from rednote_mcp.tools.note_detail import _parse_count
from rednote_mcp.tools.rednote_tools import _AUTHOR_ID_RE
from rednote_mcp.utils.logger import get_logger

logger = get_logger(__name__)

XHS_USER_URL = "https://www.xiaohongshu.com/user/profile/{user_id}"


def _build_profile_url(user_id: str, xsec_token: str = "") -> str:
    base = XHS_USER_URL.format(user_id=user_id.strip())
    if xsec_token:
        return f"{base}?xsec_token={xsec_token}&xsec_source=pc_note"
    return base


@dataclass
class RecentPost:
    title: str = ""
    url: str = ""
    cover_img: str = ""
    likes: int = 0

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class UserProfile:
    user_id: str = ""
    username: str = ""
    bio: str = ""
    followers: int = 0
    following: int = 0
    total_likes: int = 0
    recent_posts: list[RecentPost] = field(default_factory=list)
    profile_url: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


async def get_user_profile(
    context: BrowserContext,
    user_id: str,
    xsec_token: str = "",
    recent_posts_limit: int = 3,
) -> UserProfile:
    url = _build_profile_url(user_id, xsec_token)
    profile = UserProfile(profile_url=url)

    page: Page = await context.new_page()
    try:
        await page.goto(url, wait_until="domcontentloaded")

        try:
            await page.wait_for_selector(".user-info, .profile-header", timeout=15_000)
        except Exception:
            logger.warning("User profile page load timed out: %s", url)

        async def text(*selectors: str) -> str:
            for sel in selectors:
                try:
                    el = await page.query_selector(sel)
                    if el:
                        t = (await el.inner_text()).strip()
                        if t:
                            return t
                except Exception:
                    pass
            return ""

        # Extract user_id from final URL (after redirects)
        m = _AUTHOR_ID_RE.search(page.url)
        profile.user_id = m.group(1) if m else user_id

        profile.username = await text(
            ".user-info .username",
            ".info-name",
            "h1.user-name",
            ".user-name",
        )
        profile.bio = await text(
            ".user-desc",
            ".description",
            ".user-info .desc",
            ".user-info p",
        )

        # Interaction counts are typically laid out as:
        # Each stat block has a .count sibling and a .shows label (关注/粉丝/获赞与收藏)
        stat_blocks = await page.query_selector_all("[class*='interaction'] div")
        for block in stat_blocks:
            try:
                count_el = await block.query_selector(".count")
                label_el = await block.query_selector(".shows")
                if not count_el or not label_el:
                    continue
                count_val = _parse_count((await count_el.inner_text()).strip())
                label = (await label_el.inner_text()).strip()
                label_lower = label.lower()
                if "关注" in label or "following" in label_lower:
                    profile.following = count_val
                elif "粉丝" in label or "followers" in label_lower:
                    profile.followers = count_val
                elif "获赞" in label or "收藏" in label or "likes" in label_lower or "saves" in label_lower:
                    profile.total_likes = count_val
            except Exception:
                pass

        # Recent posts (card-level extraction, no clicking)
        post_items = await page.query_selector_all(
            ".user-note-list .note-item, "
            ".notes-container .note-item, "
            ".masonry-wrapper .note-item, "
            ".feeds-container .note-item"
        )
        for item in post_items[:recent_posts_limit]:
            post = RecentPost()
            try:
                # URL from cover link
                cover_a = await item.query_selector("a.cover, a[href*='/explore/']")
                if cover_a:
                    href = await cover_a.get_attribute("href")
                    if href:
                        post.url = (
                            href if href.startswith("http")
                            else f"https://www.xiaohongshu.com{href}"
                        )

                # Cover image
                cover_img = await item.query_selector("a.cover img, img.cover, .note-cover img")
                if cover_img:
                    post.cover_img = await cover_img.get_attribute("src") or ""

                # Title
                for sel in (".note-info .title", ".footer .title", "span.title", ".title"):
                    try:
                        el = await item.query_selector(sel)
                        if el:
                            post.title = (await el.inner_text()).strip()
                            if post.title:
                                break
                    except Exception:
                        pass

                # Likes
                likes_txt = ""
                for sel in (".like-wrapper .count", ".note-info .like-wrapper .count", ".interact-info .like-count", ".like-count"):
                    try:
                        el = await item.query_selector(sel)
                        if el:
                            likes_txt = (await el.inner_text()).strip()
                            if likes_txt:
                                break
                    except Exception:
                        pass
                post.likes = _parse_count(likes_txt)

                profile.recent_posts.append(post)
            except Exception as e:
                logger.warning("Error extracting recent post: %s", e)

    except Exception as e:
        logger.error("get_user_profile error: %s", e)
    finally:
        await page.close()

    return profile
