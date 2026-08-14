(function () {
	"use strict";

	const DEFAULTS = {
		enabled: true,
		debugMode: false,
		showBanner: false,
	};
	let SETTINGS = { ...DEFAULTS };

	const markedPosts = new Set();

	const PRIVACY_ATTR_SELECTOR = 'a[attributionsrc^="/privacy_sandbox/comet/register/source/"]';
	const AD_LABEL_LINK_SELECTOR = [PRIVACY_ATTR_SELECTOR, 'a[role="link"][href*="__cft__"]', 'a[role="link"][href*="/ads/about/"]'].join(",");

	const POST_SELECTORS = ['[role="article"]', '[data-pagelet*="FeedUnit"]', '[data-testid="fbfeed_story"]', ".userContentWrapper", "[data-ft]", "[aria-posinset]"];
	const POST_SELECTOR_STR = POST_SELECTORS.join(",");

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
        display: block;
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

	function wireSettingsSync() {
		chrome.storage?.sync.get(DEFAULTS, (cfg) => {
			applyNewSettings({ ...DEFAULTS, ...cfg });
		});

		chrome.runtime?.onMessage.addListener((msg) => {
			if (msg?.type === "fb-sponsored-settings-changed") {
				applyNewSettings({ ...DEFAULTS, ...msg.cfg });
			}
		});

		chrome.storage?.onChanged?.addListener((changes, area) => {
			if (area !== "sync") return;
			const next = { ...SETTINGS };
			for (const k of Object.keys(DEFAULTS)) {
				if (k in changes) next[k] = changes[k].newValue;
			}
			applyNewSettings({ ...DEFAULTS, ...next });
		});
	}

	function applyNewSettings(next) {
		const prevEnabled = SETTINGS.enabled;
		SETTINGS = next;

		if (!SETTINGS.enabled) {
			if (prevEnabled) unmarkAll();
			return;
		}

		if (!prevEnabled) {
			rafDebounce(scanForAdLabels);
		} else {
			refreshMarked();
		}
	}

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
		const nearest = el.closest?.(POST_SELECTOR_STR);
		if (nearest) return nearest;

		let cur = el,
			depth = 0;
		while (cur && cur !== document.body && depth++ < 15) {
			if (looksLikePostFrame(cur)) return cur;
			cur = cur.parentElement;
		}
		return el.closest?.("div") || el;
	}

	function normalizeGlyphText(text) {
		return (text || "")
			.normalize("NFKD")
			.replace(/[\u0300-\u036f]/g, "")
			.replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "")
			.trim();
	}

	function reconstructVisibleText(anchor) {
		const letters = [];
		const nonObfuscatedClassLetters = [];
		anchor.querySelectorAll("span").forEach((sp) => {
			const t = normalizeGlyphText(sp.textContent).replace(/\s+/g, "");
			if (t.length === 1 && /[A-Za-z0-9]/.test(t)) {
				const r = sp.getBoundingClientRect?.();
				if (r && isFinite(r.left) && isFinite(r.top) && (r.width > 0 || r.height > 0)) {
					letters.push({ ch: t, x: Math.round(r.left), y: Math.round(r.top) });
				}
				if (!/[A-Z]/.test(sp.className || "")) {
					nonObfuscatedClassLetters.push(t);
				}
			}
		});
		letters.sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y));
		const joinedByGeom = letters.map((i) => i.ch).join("");
		const joinedByClass = nonObfuscatedClassLetters.join("");
		const raw = normalizeGlyphText(anchor.textContent).replace(/\s+/g, " ").trim();
		const lettersOnly = joinedByGeom.replace(/[^A-Za-z]/g, "");
		const classLettersOnly = joinedByClass.replace(/[^A-Za-z]/g, "");
		const rawLettersOnly = raw.replace(/[^A-Za-z]/g, "");
		return { joinedByGeom, joinedByClass, lettersOnly, classLettersOnly, raw, rawLettersOnly };
	}

	function isLikelyAdLabel(recon) {
		const lo = recon.lettersOnly.toLowerCase();
		const classLo = recon.classLettersOnly.toLowerCase();
		const rawLo = recon.rawLettersOnly.toLowerCase();
		const classLooksLikeAd = classLo.length === 2 && classLo.includes("a") && classLo.includes("d");
		if (lo.includes("sponsored")) return true;
		if (classLo.includes("sponsored")) return true;
		if (rawLo === "sponsored") return true;
		if (lo === "ad" || classLo === "ad" || classLooksLikeAd || rawLo === "ad") return true;

		const endsWithEd = lo.endsWith("ed");
		const hasNoNbsp = !/[\u00A0]/.test(recon.raw);
		const firstFive = recon.joinedByGeom.slice(0, 5);
		const hasUpperSearly = /S/.test(firstFive);

		return endsWithEd && hasNoNbsp && hasUpperSearly;
	}

	function isKnownAdDisclosureLink(anchor) {
		const href = anchor?.getAttribute?.("href") || "";
		return /(?:^|\/)ads\/about(?:[/?#]|$)/i.test(href);
	}

	function hasTrackingHref(anchor) {
		const href = anchor?.getAttribute?.("href") || "";
		return href.includes("__cft__") || href.includes("**cft**");
	}

	function getSvgUseHref(use) {
		return (
			use.getAttribute("href") ||
			use.getAttribute("xlink:href") ||
			use.getAttributeNS?.("http://www.w3.org/1999/xlink", "href") ||
			use.href?.baseVal ||
			use.href?.animVal ||
			""
		);
	}

	function hasSvgGlyphReference(anchor) {
		return Array.from(anchor?.querySelectorAll?.("svg use") || []).some((use) => {
			return SVG_GLYPH_REF_RE.test(getSvgUseHref(use));
		});
	}

	function hasAudienceIcon(node) {
		return Array.from(node?.querySelectorAll?.("svg title, [aria-label], [title]") || []).some((el) => {
			const label = normalizeGlyphText(el.textContent || el.getAttribute("aria-label") || el.getAttribute("title"));
			return /shared with|public|friends|only me|custom/i.test(label);
		});
	}

	function findMetadataRow(anchor) {
		let cur = anchor?.parentElement;
		for (let depth = 0; cur && cur !== document.body && depth < 6; depth++) {
			const text = normalizeGlyphText(cur.textContent);
			if (text.includes("\u00b7") && hasAudienceIcon(cur)) return cur;
			cur = cur.parentElement;
		}
		return null;
	}

	function isCompactSvgLabel(anchor) {
		const svg = anchor?.querySelector?.("svg");
		const r = (svg || anchor)?.getBoundingClientRect?.();
		if (!r || !isFinite(r.width) || !isFinite(r.height)) return false;
		return r.width >= 8 && r.width <= 72 && r.height >= 8 && r.height <= 28;
	}

	function isSvgAdDisclosureLabel(anchor) {
		if (!hasSvgGlyphReference(anchor)) return false;
		if (!isCompactSvgLabel(anchor)) return false;
		return !!findMetadataRow(anchor);
	}

	function collectSelectorCandidates(selectors) {
		const candidates = new Set();
		document.querySelectorAll(selectors.join(",")).forEach((el) => candidates.add(el));
		return candidates;
	}

	function collectSvgGlyphAnchors() {
		const candidates = new Set();
		document.querySelectorAll(SVG_USE_SELECTOR).forEach((use) => {
			if (SVG_GLYPH_REF_RE.test(getSvgUseHref(use))) {
				const anchor = use.closest("a");
				if (anchor) candidates.add(anchor);
			}
		});
		return candidates;
	}

	// Add new Facebook label variants here; each detector owns its candidates and match rule.
	const AD_LABEL_DETECTORS = [
		{
			name: "ads-about",
			selectors: [ADS_ABOUT_SELECTOR],
			detect(anchor) {
				if (!isKnownAdDisclosureLink(anchor)) return null;
				return hasSvgGlyphReference(anchor) ? "ads-about-svg" : "ads-about-link";
			},
		},
		{
			name: "svg-metadata",
			collectCandidates: collectSvgGlyphAnchors,
			detect(anchor) {
				return isSvgAdDisclosureLabel(anchor) ? "svg-metadata" : null;
			},
		},
		{
			name: "obfuscated-text",
			selectors: [PRIVACY_ATTR_SELECTOR, TRACKING_HREF_SELECTOR],
			detect(anchor) {
				if (!anchor.matches?.(PRIVACY_ATTR_SELECTOR) && !hasTrackingHref(anchor)) return null;
				return isLikelyAdLabel(reconstructVisibleText(anchor)) ? "obfuscated-text" : null;
			},
		},
	];

	function getDetectorCandidates(detector) {
		if (detector.collectCandidates) return detector.collectCandidates();
		return collectSelectorCandidates(detector.selectors);
	}

	function removePlaceholderFor(post) {
		const tracked = placeholderByPost.get(post);
		if (tracked?.isConnected) tracked.remove();
		placeholderByPost.delete(post);

		let prev = post.previousElementSibling;
		while (prev?.classList?.contains("sponsored-placeholder")) {
			const duplicate = prev;
			prev = duplicate.previousElementSibling;
			duplicate.remove();
		}
	}

	function ensurePlaceholderFor(post) {
		if (!SETTINGS.showBanner) return;
		const prev = post.previousElementSibling;
		if (prev?.classList?.contains("sponsored-placeholder")) return;
		const ph = document.createElement("div");
		ph.className = "sponsored-placeholder";
		ph.textContent = "Sponsored post hidden";
		post.parentNode?.insertBefore(ph, post);
	}

	function markPost(post, mode /* 'hide' | 'highlight' */) {
		if (!post) return;
		post.classList.remove("sponsored-hidden-post", "sponsored-detected-post");
		if (mode === "hide") {
			ensurePlaceholderFor(post);
			post.classList.add("sponsored-hidden-post");
		} else {
			post.classList.add("sponsored-detected-post");
		}
		markedPosts.add(post);
	}

	function unmark(post) {
		if (!post) return;
		post.classList.remove("sponsored-hidden-post", "sponsored-detected-post");
		const prev = post.previousElementSibling;
		if (prev && prev.classList?.contains("sponsored-placeholder")) prev.remove();
	}

	function unmarkAll() {
		for (const p of markedPosts) unmark(p);
		markedPosts.clear();
	}

	function refreshMarked() {
		for (const post of markedPosts) {
			markPost(post, SETTINGS.debugMode ? "highlight" : "hide");
		}
	}

	function scanForAdLabels() {
		if (!SETTINGS.enabled) return;
		for (const a of document.querySelectorAll(AD_LABEL_LINK_SELECTOR)) {
			const recon = reconstructVisibleText(a);
			const hit = isLikelyAdLabel(recon);
			if (!hit) continue;

			const post = getPostContainerFrom(a) || a.closest(POST_SELECTOR_STR);
			if (!post) continue;

			markPost(post, SETTINGS.debugMode ? "highlight" : "hide");
		}
	}

	function initObserver() {
		const observer = new MutationObserver((mutations) => {
			for (const m of mutations) {
				if (m.type === "childList" && (m.addedNodes?.length || m.removedNodes?.length)) {
					rafDebounce(scanForAdLabels);
					return;
				}
				if (
					m.type === "attributes" &&
					(m.attributeName === "attributionsrc" || m.attributeName === "href") &&
					m.target?.matches?.(AD_LABEL_LINK_SELECTOR)
				) {
					rafDebounce(scanForAdLabels);
					return;
				}
			}
		});

		observer.observe(document.body, {
			subtree: true,
			childList: true,
			attributes: true,
			attributeFilter: ["attributionsrc", "href"],
		});

		scanForAdLabels();
	}

	function initialize() {
		injectStylesOnce();
		wireSettingsSync();
		initObserver();
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", initialize, { once: true });
	} else {
		initialize();
	}
})();
