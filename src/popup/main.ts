document.getElementById("open-options")?.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

const versionEl = document.getElementById("version");
if (versionEl) {
  versionEl.textContent = `v${chrome.runtime.getManifest().version}`;
}