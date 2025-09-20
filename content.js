(function () {
	"use strict";

	// =========================
	// SETTINGS
	// =========================
	const DEFAULTS = {
		enabled: true, // NEW master switch
		debugMode: false, // OFF => hide
		showBanner: false,
	};
	let SETTINGS = { ...DEFAULTS };

	// Track posts so we can revert when disabling
	const markedPosts = new Set(); // stores Elements we touched

	chrome.storage?.sync.get(DEFAULTS, (cfg) => {
		SETTINGS = { ...DEFAULTS, ...cfg };
	});

	chrome.runtime?.onMessage.addListener((msg) => {
		if (msg?.type === "fb-sponsored-settings-changed") {
			applyNewSettings(msg.cfg);
		}
	});
	chrome.storage?.onChanged?.addListener((changes, area) => {
		if (area === "sync") {
			const next = { ...SETTINGS };
			for (const k of Object.keys(DEFAULTS)) {
				if (k in changes) next[k] = changes[k].newValue;
			}
			applyNewSettings(next);
		}
	});

	function applyNewSettings(next) {
		const prev = { ...SETTINGS };
		SETTINGS = { ...DEFAULTS, ...next };
		if (!SETTINGS.enabled && prev.enabled) {
			unmarkAll();
		} else if (SETTINGS.enabled && !prev.enabled) {
			rafDebounce(scanForObfuscatedAnchors);
		} else {
			refreshMarked();
		}
	}

	// =========================
	// CONSTANTS
	// =========================
	const PRIVACY_ATTR_SELECTOR = 'a[attributionsrc^="/privacy_sandbox/comet/register/source/"]';
	const POST_SELECTORS = ['[role="article"]', '[data-pagelet*="FeedUnit"]', '[data-testid="fbfeed_story"]', ".userContentWrapper", "[data-ft]", "[aria-posinset]"];

	// =========================
	// STYLES
	// =========================
	function injectStylesOnce() {
		if (document.getElementById("sponsor-detector-styles")) return;
		const css = `
      .sponsored-detected-post {
        position: relative !important;
        outline: 1px solid #ff3b30 !important;
        border-radius: 10px !important;
      }
      .sponsored-detected-post::before {
        content: "SPONSORED (auto-detected)";
        position: absolute; z-index: 9999; top: 8px; left: 8px;
        font: 600 12px/1.2 system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
        color: #fff; background: #ff3b30; padding: 4px 8px; border-radius: 6px;
        pointer-events: none;
      }

      .sponsored-hidden-post { display: none !important; }

      .sponsored-placeholder {
        display: block; /* always block; we control presence programmatically */
        width: 100%;
        margin: 8px 0;
        padding: 10px 12px;
        border-radius: 8px;
        border: 1px dashed #999;
        font: 500 13px/1.2 system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
        color: #ff3b30;
        background: rgba(0,0,0,0.03);
      }
    `;
		const style = document.createElement("style");
		style.id = "sponsor-detector-styles";
		style.textContent = css;
		document.documentElement.appendChild(style);
	}

	// =========================
	// HELPERS
	// =========================
	const rafDebounce = (() => {
		let scheduled = false;
		return (fn) => {
			if (scheduled) return;
			scheduled = true;
			requestAnimationFrame(() => {
				scheduled = false;
				fn();
			});
		};
	})();

	function looksLikePostFrame(node) {
		if (!node || node.nodeType !== 1) return false;
		const hasPos = node.hasAttribute?.("aria-posinset");
		const r = node.getBoundingClientRect?.();
		const bigEnough = r && r.height >= 180 && r.width >= 280;
		return !!(hasPos || bigEnough);
	}

	function getPostContainerFrom(el) {
		if (!el) return null;
		const nearest = el.closest?.(POST_SELECTORS.join(","));
		if (nearest) return nearest;

		let cur = el,
			depth = 0;
		while (cur && cur !== document.body && depth++ < 15) {
			if (looksLikePostFrame(cur)) return cur;
			cur = cur.parentElement;
		}
		return el.closest?.("div") || el;
	}

	function reconstructVisibleText(anchor) {
		const letters = [];
		anchor.querySelectorAll("span").forEach((sp) => {
			const t = (sp.textContent || "").trim();
			if (t.length === 1 && /[A-Za-z0-9]/.test(t)) {
				const r = sp.getBoundingClientRect?.();
				if (r && isFinite(r.left) && isFinite(r.top)) {
					letters.push({ ch: t, x: Math.round(r.left), y: Math.round(r.top) });
				}
			}
		});
		letters.sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y));
		const joinedByGeom = letters.map((i) => i.ch).join("");
		const raw = (anchor.textContent || "").replace(/\s+/g, " ").trim();
		const lettersOnly = joinedByGeom.replace(/[^A-Za-z]/g, "");

		return { joinedByGeom, lettersOnly, raw };
	}

	function isLikelySponsored(recon) {
		const lo = recon.lettersOnly.toLowerCase();
		if (lo.includes("sponsored")) return true;

		const endsWithEd = lo.endsWith("ed");
		const hasNoNbsp = !/[\u00A0]/.test(recon.raw);
		const firstFive = recon.joinedByGeom.slice(0, 5);
		const hasUpperSearly = /S/.test(firstFive);

		return endsWithEd && hasNoNbsp && hasUpperSearly;
	}

	// Banners
	function ensurePlaceholderFor(post) {
		if (!SETTINGS.showBanner) return null;

		let ph = post.previousElementSibling;
		if (!(ph && ph.classList?.contains("sponsored-placeholder"))) {
			ph = document.createElement("div");
			ph.className = "sponsored-placeholder";
			ph.textContent = "Sponsored post hidden";
			post.parentNode?.insertBefore(ph, post);
		}
		return ph;
	}

	// Hide/Show/Highlight
	function hideWholePost(post) {
		if (!post) return;
		if (SETTINGS.showBanner) ensurePlaceholderFor(post);
		post.classList.remove("sponsored-detected-post");
		post.classList.add("sponsored-hidden-post");
		markedPosts.add(post);
	}

    // Remove hidden state if switching from hide -> highlight
	function highlightWholePost(post) {
		if (!post) return;
		post.classList.remove("sponsored-hidden-post");
		post.classList.add("sponsored-detected-post");
		markedPosts.add(post);
	}

	function unmark(post) {
		if (!post) return;
		post.classList.remove("sponsored-hidden-post", "sponsored-detected-post");
		// Remove any placeholder we inserted (only the immediate previous sibling we created)
		const prev = post.previousElementSibling;
		if (prev && prev.classList?.contains("sponsored-placeholder")) prev.remove();
	}

	function unmarkAll() {
		for (const p of markedPosts) unmark(p);
		markedPosts.clear();
	}

	function refreshMarked() {
		for (const post of markedPosts) {
			post.classList.remove("sponsored-hidden-post", "sponsored-detected-post");
			if (SETTINGS.debugMode) {
				highlightWholePost(post);
			} else {
				hideWholePost(post);
			}
		}
	}

	// =========================
	// CORE SCAN
	// =========================
	function scanForObfuscatedAnchors() {
		if (!SETTINGS.enabled) return;

		const anchors = document.querySelectorAll(PRIVACY_ATTR_SELECTOR);
		anchors.forEach((a) => {
			const recon = reconstructVisibleText(a);
			const hit = isLikelySponsored(recon);
			if (!hit) return;

			const post = getPostContainerFrom(a) || a.closest(POST_SELECTORS.join(","));
			if (!post) return;

			if (SETTINGS.debugMode) {
				highlightWholePost(post);
			} else {
				hideWholePost(post);
			}
		});
	}

	// =========================
	// OBSERVER
	// =========================
	function initObserver() {
		const observer = new MutationObserver((mutations) => {
			let shouldScan = false;
			for (const m of mutations) {
				if (m.type === "childList" && (m.addedNodes?.length || m.removedNodes?.length)) {
					shouldScan = true;
					break;
				}
				if (m.type === "attributes" && m.attributeName === "attributionsrc") {
					if (m.target?.matches?.(PRIVACY_ATTR_SELECTOR)) {
						shouldScan = true;
						break;
					}
				}
			}
			if (shouldScan) rafDebounce(scanForObfuscatedAnchors);
		});

		observer.observe(document.body, {
			subtree: true,
			childList: true,
			attributes: true,
			attributeFilter: ["attributionsrc"],
		});

		scanForObfuscatedAnchors();
	}

	// =========================
	// BOOT
	// =========================
	function initialize() {
		injectStylesOnce();
		initObserver();
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", initialize, { once: true });
	} else {
		initialize();
	}
})();
