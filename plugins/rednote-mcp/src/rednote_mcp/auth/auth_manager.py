import asyncio
from playwright.async_api import async_playwright, Browser, BrowserContext, Page
from playwright_stealth import Stealth

from rednote_mcp.auth.cookie_manager import save_cookies, load_cookies, clear_cookies
from rednote_mcp.utils.logger import get_logger

_stealth = Stealth(
    navigator_languages_override=("zh-CN", "zh"),
    navigator_platform_override="Linux x86_64",
)

logger = get_logger(__name__)

XHS_HOME = "https://www.xiaohongshu.com/explore"
MAX_RETRIES = 3

# Global headless mode flag.
_headless: bool = True

# Persistent browser session — reused across tool calls to avoid the
# open-fresh-browser-every-call pattern that looks very bot-like.
_playwright_instance = None
_persistent_browser: Browser | None = None
_persistent_context: BrowserContext | None = None

_CONTEXT_OPTIONS = {
    "user_agent": (
        "Mozilla/5.0 (X11; Linux x86_64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/145.0.0.0 Safari/537.36"
    ),
    "viewport": {"width": 1440, "height": 900},
    "locale": "zh-CN",
    "timezone_id": "Asia/Shanghai",
    "extra_http_headers": {
        "Accept": (
            "text/html,application/xhtml+xml,application/xml;q=0.9,"
            "image/avif,image/webp,image/apng,*/*;q=0.8,"
            "application/signed-exchange;v=b3;q=0.7"
        ),
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Referer": "https://www.xiaohongshu.com/",
    },
}


def set_browser_headless(headless: bool) -> None:
    global _headless
    _headless = headless
    logger.info("Browser headless mode set to: %s", headless)


async def get_persistent_context() -> tuple[Browser, BrowserContext]:
    """
    Return a long-lived browser + context, reusing it across calls.
    Creates a new one if none exists or if the existing one is stale.
    """
    global _playwright_instance, _persistent_browser, _persistent_context

    # Health-check existing session
    if _persistent_context and _persistent_browser:
        try:
            await _persistent_context.cookies()
            return _persistent_browser, _persistent_context
        except Exception:
            _persistent_context = None
            _persistent_browser = None

    if _playwright_instance is None:
        _playwright_instance = await async_playwright().start()

    cookies = load_cookies()
    if not cookies:
        raise RuntimeError("Not authenticated. Please run the login tool first.")

    _persistent_browser = await _playwright_instance.chromium.launch(headless=_headless)
    _persistent_context = await _persistent_browser.new_context(**_CONTEXT_OPTIONS)
    await _stealth.apply_stealth_async(_persistent_context)
    await _persistent_context.add_cookies(cookies)
    logger.info("Persistent browser session started (headless=%s)", _headless)
    return _persistent_browser, _persistent_context


async def reset_persistent_context() -> None:
    """Close the persistent session so it is rebuilt on the next tool call."""
    global _persistent_browser, _persistent_context
    if _persistent_browser:
        try:
            await _persistent_browser.close()
        except Exception:
            pass
    _persistent_browser = None
    _persistent_context = None
    logger.info("Persistent browser session reset")


async def login(timeout_seconds: int = 60, force: bool = False) -> bool:
    """
    Launch a visible browser, navigate to XiaoHongShu, and wait for the user
    to scan the QR code. Saves cookies on success.
    If force=True, existing cookies are cleared before starting a fresh session.
    Returns True on success, False otherwise.
    """
    if force:
        clear_cookies()
        logger.info("Force login: existing cookies cleared")

    attempt = 0
    while attempt < MAX_RETRIES:
        attempt += 1
        logger.info("Login attempt %d/%d", attempt, MAX_RETRIES)
        try:
            async with async_playwright() as p:
                browser: Browser = await p.chromium.launch(headless=False)
                context: BrowserContext = await browser.new_context(**_CONTEXT_OPTIONS)
                await _stealth.apply_stealth_async(context)

                existing = load_cookies()
                if existing:
                    await context.add_cookies(existing)

                page: Page = await context.new_page()
                await page.goto(XHS_HOME, wait_until="domcontentloaded")

                # Check if already logged in
                try:
                    await page.wait_for_selector(
                        ".user.side-bar-component .channel", timeout=3000
                    )
                    logger.info("Already logged in via existing cookies")
                    cookies = await context.cookies()
                    save_cookies(cookies)
                    await browser.close()
                    return True
                except Exception:
                    pass

                # Wait for QR code
                logger.info("Waiting for QR code to appear...")
                await page.wait_for_selector(".qrcode-img", timeout=10_000)
                logger.info(
                    "QR code displayed. Please scan within %d seconds.", timeout_seconds
                )

                # Wait for login completion
                try:
                    await page.wait_for_selector(
                        ".user.side-bar-component .channel",
                        timeout=timeout_seconds * 1000,
                    )
                    cookies = await context.cookies()
                    save_cookies(cookies)
                    logger.info("Login successful")
                    await browser.close()
                    await reset_persistent_context()
                    return True
                except Exception:
                    logger.warning("Login timed out on attempt %d", attempt)
                    await browser.close()
        except Exception as e:
            logger.error("Login error on attempt %d: %s", attempt, e)

    return False


