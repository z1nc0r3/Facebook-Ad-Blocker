const DEFAULTS = {
	enabled: true,
	debugMode: false,
	showBanner: false,
};

const $ = (id) => document.getElementById(id);

async function load() {
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

// Preventing both DebugMode and ShowBanner options are enabled at the same time.
function handleMutualExclusion(changedCheckbox) {
	const debugMode = $("debugMode");
	const showBanner = $("showBanner");

	if (changedCheckbox === debugMode && debugMode.checked) {
		showBanner.checked = false;
	} else if (changedCheckbox === showBanner && showBanner.checked) {
		debugMode.checked = false;
	}
}

document.addEventListener("DOMContentLoaded", () => {
	load();

	$("debugMode").addEventListener("click", (e) => {
		handleMutualExclusion(e.target);
	});

	$("showBanner").addEventListener("click", (e) => {
		handleMutualExclusion(e.target);
	});

	$("saveBtn").addEventListener("click", save);
});
