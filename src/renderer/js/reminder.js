// Buy reminder popup renderer. Receives one payload per reminder from the main
// process and redraws the card; the window's show/hide is handled there.
const rmCard  = document.getElementById('rmCard');
const rmGold  = document.getElementById('rmGold');
const rmItems = document.getElementById('rmItems');
const rmStep  = document.getElementById('rmStep');

let ddragonVersion = '15.1.1';
let leaveTimer = null;

function escHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function itemIconUrl(id) {
    return `https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/item/${id}.png`;
}

window.reminderAPI.onInit((data) => {
    if (data?.ddragonVersion) ddragonVersion = data.ddragonVersion;
});

window.reminderAPI.onReminder((r) => {
    if (!r?.items?.length) return;

    rmGold.textContent = r.gold;
    rmStep.textContent = `${r.index + 1}/${r.totalSteps}`;
    rmItems.innerHTML = r.items.map(it => `
        <span class="rm-item">
            <img src="${itemIconUrl(it.id)}" onerror="this.style.display='none'">
            <span class="rm-item-name">${escHtml(it.name)}</span>
        </span>`).join('');

    // Restart the entry animation even when a second reminder lands while the
    // first card is still on screen.
    clearTimeout(leaveTimer);
    rmCard.classList.remove('leaving');
    void rmCard.offsetWidth;   // reflow, so the animation re-runs

    // Fade out just before the main process hides the window.
    if (r.durationMs) {
        leaveTimer = setTimeout(() => rmCard.classList.add('leaving'), Math.max(0, r.durationMs - 300));
    }
});
