const DEFAULTS = {
	enabled: true,
	debugMode: false,
	showBanner: false,
};

const $ = (id) => document.getElementById(id);

async function load() {
	const currentVersion = chrome.runtime.getManifest().version;
	const verBadge = $("appVersion");
	if (verBadge) verBadge.textContent = `v${currentVersion}`;

	const cfg = await chrome.storage.sync.get(DEFAULTS);
	$("enabled").checked = !!cfg.enabled;
	$("debugMode").checked = !!cfg.debugMode;
	$("showBanner").checked = !!cfg.showBanner;
}

async function save() {
	const cfg = {
		enabled: $("enabled").checked,
		debugMode: $("debugMode").checked,
		showBanner: $("showBanner").checked,
	};
	await chrome.storage.sync.set(cfg);

	chrome.tabs.query({ url: ["*://*.facebook.com/*", "*://facebook.com/*"] }, (tabs) => {
		for (const t of tabs) chrome.tabs.sendMessage(t.id, { type: "fb-sponsored-settings-changed", cfg });
	});

	const ok = $("savedOk");
	ok.style.display = "inline";
	setTimeout(() => (ok.style.display = "none"), 1200);
}

function handleMutualExclusion(changedCheckbox) {
	const debugMode = $("debugMode");
	const showBanner = $("showBanner");

	if (changedCheckbox === debugMode && debugMode.checked) {
		showBanner.checked = false;
	} else if (changedCheckbox === showBanner && showBanner.checked) {
		debugMode.checked = false;
	}
}

const GITHUB_REPO = "z1nc0r3/Facebook-Ad-Blocker";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

function isNewerVersion(latest, current) {
	const cleanVersion = (v) => v.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
	const l = cleanVersion(latest);
	const c = cleanVersion(current);
	for (let i = 0; i < Math.max(l.length, c.length); i++) {
		const numL = l[i] || 0;
		const numC = c[i] || 0;
		if (numL > numC) return true;
		if (numL < numC) return false;
	}
	return false;
}

function displayUpdateBanner(latestVersion, releaseUrl) {
	const banner = $("updateBanner");
	const verSpan = $("updateVersion");
	const link = $("updateLink");
	if (banner && verSpan && link) {
		verSpan.textContent = `v${latestVersion} is out on GitHub!`;
		link.href = releaseUrl;
		banner.style.display = "flex";
	}
}

async function renderFromCache() {
	try {
		const currentVersion = chrome.runtime.getManifest().version;
		const { githubUpdateCache } = await chrome.storage.local.get("githubUpdateCache");
		if (githubUpdateCache && githubUpdateCache.latestVersion) {
			if (isNewerVersion(githubUpdateCache.latestVersion, currentVersion)) {
				displayUpdateBanner(githubUpdateCache.latestVersion, githubUpdateCache.releaseUrl);
			}
		}
	} catch (e) {
		console.warn("Error reading update cache:", e);
	}
}

async function fetchInBackground() {
	const currentVersion = chrome.runtime.getManifest().version;
	const now = Date.now();

	const { githubUpdateCache } = await chrome.storage.local.get("githubUpdateCache");
	if (githubUpdateCache && githubUpdateCache.lastChecked && now - githubUpdateCache.lastChecked < CHECK_INTERVAL_MS) {
		return; // Cache is still fresh (checked within last 24h)
	}

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 3000); // 3 second strict timeout

	try {
		const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
			signal: controller.signal,
		});
		clearTimeout(timeoutId);
		if (!res.ok) return;

		const data = await res.json();
		const latestTag = data.tag_name || "";
		const releaseUrl = data.html_url || `https://github.com/${GITHUB_REPO}/releases`;
		const latestVersion = latestTag.replace(/^v/, "");

		await chrome.storage.local.set({
			githubUpdateCache: {
				lastChecked: now,
				latestVersion,
				releaseUrl,
			},
		});

		if (isNewerVersion(latestVersion, currentVersion)) {
			displayUpdateBanner(latestVersion, releaseUrl);
		}
	} catch (err) {
		clearTimeout(timeoutId);
		if (err.name !== "AbortError") {
			console.warn("Failed to check for extension updates:", err);
		}
	}
}

document.addEventListener("DOMContentLoaded", () => {
	load();
	renderFromCache();

	// Defer network request to background after UI is painted
	setTimeout(fetchInBackground, 300);

	$("debugMode").addEventListener("click", (e) => {
		handleMutualExclusion(e.target);
	});

	$("showBanner").addEventListener("click", (e) => {
		handleMutualExclusion(e.target);
	});

	$("saveBtn").addEventListener("click", save);
});
