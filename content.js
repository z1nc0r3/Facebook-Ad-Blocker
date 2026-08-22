(function () {
	"use strict";

	const DEFAULTS = {
		enabled: true,
		debugMode: false,
		showBanner: false,
	};
	let SETTINGS = { ...DEFAULTS };

	const markedPosts = new Set();
	const placeholderByPost = new WeakMap();

	const PRIVACY_ATTR_SELECTOR = 'a[attributionsrc^="/privacy_sandbox/comet/register/source/"]';
	const OBFUSCATED_LABEL_LINK_SELECTOR = 'a[href^="?"][href*="__cft__"][target="_blank"]';
	const SVG_USE_SELECTOR = "a svg use";
	// Facebook clips a wider generated SVG; the rendered "Ad" segment occupies about 15.92px.
	const SVG_AD_CLIPPED_WIDTH = 15.92;
	const SVG_AD_CLIPPED_WIDTH_TOLERANCE = 0.25;
	// Generated metadata-text families; the clipped width identifies the rendered Ad label.
	const SVG_GLYPH_REF_PATTERNS = [/^#SvgT\d*$/i, /^#SvgWml\d+$/i];
	const AD_LABEL_ATTRIBUTE_SELECTOR = [PRIVACY_ATTR_SELECTOR, OBFUSCATED_LABEL_LINK_SELECTOR].join(",");

	const POST_SELECTORS = ['[role="article"]', '[data-pagelet*="FeedUnit"]', '[data-testid="fbfeed_story"]', ".userContentWrapper", "[data-ft]", "[aria-posinset]"];
	const POST_SELECTOR_STR = POST_SELECTORS.join(",");

	function injectStylesOnce() {
		const css = `
      .sponsored-detected-post {
        outline: 1px solid #ff3b30 !important;
        border-radius: 10px !important;
      }
      .sponsored-debug-positioned { position: relative !important; }
      .sponsored-detected-post::before {
        content: "AD (" attr(data-sponsor-detector-method) ")";
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
		let style = document.getElementById("sponsor-detector-styles");
		if (!style) {
			style = document.createElement("style");
			style.id = "sponsor-detector-styles";
			document.documentElement.appendChild(style);
		}
		style.textContent = css;
	}

	function wireSettingsSync() {
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

	function loadInitialSettings() {
		return new Promise((resolve) => {
			if (!chrome.storage?.sync?.get) {
				resolve();
				return;
			}

			chrome.storage.sync.get(DEFAULTS, (cfg) => {
				SETTINGS = { ...DEFAULTS, ...cfg };
				resolve();
			});
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
			revealHiddenPostsForDebug();
			rafDebounce(scanForAdLabels);
		} else {
			refreshMarked();
			revealHiddenPostsForDebug();
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
		const candidates = [recon.lettersOnly, recon.classLettersOnly, recon.rawLettersOnly].map((text) => text.toLowerCase());
		return candidates.some((text) => text === "ad" || text === "da" || text === "sponsored");
	}

	function isObfuscatedLabelLink(anchor) {
		return !!anchor?.matches?.(OBFUSCATED_LABEL_LINK_SELECTOR);
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

	function isKnownSvgGlyphReference(reference) {
		return SVG_GLYPH_REF_PATTERNS.some((pattern) => pattern.test(reference));
	}

	function hasSvgGlyphReference(anchor) {
		return Array.from(anchor?.querySelectorAll?.("svg use") || []).some((use) => {
			return isKnownSvgGlyphReference(getSvgUseHref(use));
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

	function parsePixelValue(value) {
		const parsed = Number.parseFloat(value || "");
		return Number.isFinite(parsed) ? parsed : null;
	}

	function getSvgClippedWidth(svg) {
		let width = parsePixelValue(svg?.style?.width);
		let marginRight = parsePixelValue(svg?.style?.marginRight);

		if (width === null || marginRight === null) {
			const computed = svg ? window.getComputedStyle(svg) : null;
			if (width === null) width = parsePixelValue(computed?.width);
			if (marginRight === null) marginRight = parsePixelValue(computed?.marginRight);
		}

		if (width === null || marginRight === null) return null;
		return width + marginRight;
	}

	function hasAdSvgClippedWidth(anchor) {
		return Array.from(anchor?.querySelectorAll?.("svg") || []).some((svg) => {
			const use = svg.querySelector?.("use");
			if (!use || !isKnownSvgGlyphReference(getSvgUseHref(use))) return false;

			const clippedWidth = getSvgClippedWidth(svg);
			return clippedWidth !== null && Math.abs(clippedWidth - SVG_AD_CLIPPED_WIDTH) <= SVG_AD_CLIPPED_WIDTH_TOLERANCE;
		});
	}

	function isSvgAdDisclosureLabel(anchor) {
		if (!hasSvgGlyphReference(anchor)) return false;
		if (!hasAdSvgClippedWidth(anchor)) return false;
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
			if (isKnownSvgGlyphReference(getSvgUseHref(use))) {
				const anchor = use.closest("a");
				if (anchor) candidates.add(anchor);
			}
		});
		return candidates;
	}

	// Both detectors verify the label itself: reconstructed text or measured SVG clipping.
	const AD_LABEL_DETECTORS = [
		{
			name: "obfuscated-text",
			selectors: [PRIVACY_ATTR_SELECTOR, OBFUSCATED_LABEL_LINK_SELECTOR],
			detect(anchor) {
				if (!anchor.matches?.(PRIVACY_ATTR_SELECTOR) && !isObfuscatedLabelLink(anchor)) return null;
				if (!findMetadataRow(anchor)) return null;
				return isLikelyAdLabel(reconstructVisibleText(anchor)) ? "obfuscated-text" : null;
			},
		},
		{
			name: "svg-clipped-width",
			collectCandidates: collectSvgGlyphAnchors,
			detect(anchor) {
				return isSvgAdDisclosureLabel(anchor) ? "svg-clipped-width" : null;
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
		const tracked = placeholderByPost.get(post);
		if (tracked?.isConnected && tracked.nextElementSibling === post) return;
		if (tracked?.isConnected) tracked.remove();

		const prev = post.previousElementSibling;
		if (prev?.classList?.contains("sponsored-placeholder")) {
			placeholderByPost.set(post, prev);
			return;
		}

		const ph = document.createElement("div");
		ph.className = "sponsored-placeholder";
		ph.textContent = "Sponsored post hidden";
		post.parentNode?.insertBefore(ph, post);
		placeholderByPost.set(post, ph);
	}

	function applyDebugPositioning(post) {
		post.classList.remove("sponsored-debug-positioned");
		if (window.getComputedStyle(post).position === "static") {
			post.classList.add("sponsored-debug-positioned");
		}
	}

	function markPost(post, mode /* 'hide' | 'highlight' */, method = "auto-detected") {
		if (!post) return;
		post.classList.remove("sponsored-hidden-post", "sponsored-detected-post", "sponsored-debug-positioned");
		post.dataset.sponsorDetectorMethod = method;
		if (mode === "hide") {
			if (SETTINGS.showBanner) {
				ensurePlaceholderFor(post);
			} else {
				removePlaceholderFor(post);
			}
			post.classList.add("sponsored-hidden-post");
		} else {
			removePlaceholderFor(post);
			post.classList.add("sponsored-detected-post");
			applyDebugPositioning(post);
		}
		markedPosts.add(post);
	}

	function unmark(post) {
		if (!post) return;
		post.classList.remove("sponsored-hidden-post", "sponsored-detected-post", "sponsored-debug-positioned");
		delete post.dataset.sponsorDetectorMethod;
		removePlaceholderFor(post);
	}

	function unmarkAll() {
		for (const p of markedPosts) unmark(p);
		markedPosts.clear();
	}

	function refreshMarked() {
		for (const post of markedPosts) {
			markPost(post, SETTINGS.debugMode ? "highlight" : "hide", post.dataset.sponsorDetectorMethod);
		}
	}

	function revealHiddenPostsForDebug() {
		if (!SETTINGS.enabled || !SETTINGS.debugMode) return;

		for (const post of document.querySelectorAll(".sponsored-hidden-post")) {
			const method = post.dataset.sponsorDetectorMethod || "previous-detection";
			markPost(post, "highlight", method);
		}
	}

	function scanForAdLabels() {
		if (!SETTINGS.enabled) return;
		revealHiddenPostsForDebug();

		const matchedAnchors = new WeakSet();
		const matchedPosts = new WeakSet();
		for (const detector of AD_LABEL_DETECTORS) {
			for (const a of getDetectorCandidates(detector)) {
				if (matchedAnchors.has(a)) continue;

				const method = detector.detect(a);
				if (!method) continue;
				matchedAnchors.add(a);

				const post = getPostContainerFrom(a) || a.closest(POST_SELECTOR_STR);
				if (!post) continue;
				if (matchedPosts.has(post)) continue;

				matchedPosts.add(post);
				markPost(post, SETTINGS.debugMode ? "highlight" : "hide", method);
			}
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
					(m.attributeName === "attributionsrc" || m.attributeName === "href" || m.attributeName === "xlink:href") &&
					(m.target?.matches?.(AD_LABEL_ATTRIBUTE_SELECTOR) || m.target?.matches?.(SVG_USE_SELECTOR))
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
			attributeFilter: ["attributionsrc", "href", "xlink:href"],
		});

		scanForAdLabels();
	}

	async function initialize() {
		injectStylesOnce();
		wireSettingsSync();
		await loadInitialSettings();
		initObserver();
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", initialize, { once: true });
	} else {
		initialize();
	}
})();
