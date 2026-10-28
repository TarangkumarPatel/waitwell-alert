const DEFAULTS = { glow: true, sound: true, desktop: false, teams: false, teamsUrl: '' };

// Dashboard data lives in chrome.storage.session: memory on this laptop only, wiped
// when Chrome closes. Nothing here is ever sent anywhere.
const recordCall = async (ticket) => {
    const { calls = [] } = await chrome.storage.session.get('calls');
    const now = Date.now();
    const next = [...calls, { key: ticket.key || '', name: ticket.student, table: ticket.table, rep: ticket.rep, at: now, test: !!ticket.test }]
        .filter((call) => now - call.at < 4 * 60 * 60 * 1000)
        .slice(-30);
    await chrome.storage.session.set({ calls: next });
};

const openDashboard = async () => {
    const url = chrome.runtime.getURL('dashboard.html');
    const [existing] = await chrome.tabs.query({ url });
    if (existing) {
        await chrome.tabs.update(existing.id, { active: true });
        await chrome.windows.update(existing.windowId, { focused: true });
        return;
    }
    await chrome.windows.create({ url, type: 'popup', width: 1500, height: 900 });
};

// Dashboard buttons -> the Waitwell tab, which does the actual clicking.
const relayToWaitwell = async (message) => {
    const { boardTab } = await chrome.storage.session.get('boardTab');
    if (!boardTab) return { ok: false, error: 'Waitwell tab not found. Is Waitwell open?' };
    try {
        return await chrome.tabs.sendMessage(boardTab, message) || { ok: false, error: 'No answer from Waitwell' };
    } catch (error) {
        return { ok: false, error: 'Waitwell tab not reachable. Refresh Waitwell and try again.' };
    }
};

const getSettings = () => chrome.storage.sync.get(DEFAULTS);

const messageFor = (ticket) => `${ticket.student} to ${ticket.rep} at ${ticket.table}`;

// Offscreen document plays the chime, so it works whatever tab, site or app you're in.
// Chrome closes it after a while of silence, so it's re-created on demand, and we wait
// until it confirms it's listening before asking it to play.
let creatingOffscreen = null;
const ensureOffscreen = async () => {
    const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (existing.length) return;
    if (!creatingOffscreen) {
        creatingOffscreen = chrome.offscreen.createDocument({
            url: 'offscreen.html',
            reasons: ['AUDIO_PLAYBACK'],
            justification: 'Chime when a Waitwell ticket is accepted'
        }).catch((error) => {
            if (!/single offscreen/i.test(error.message)) throw error;
        }).finally(() => { creatingOffscreen = null; });
    }
    await creatingOffscreen;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const playChime = async () => {
    await ensureOffscreen();
    for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
            const reply = await chrome.runtime.sendMessage({ type: 'play-chime' });
            if (reply && reply.played) return;
        } catch (error) { /* offscreen page still loading */ }
        await sleep(150);
    }
    throw new Error('audio page did not respond');
};

// Desktop (Windows / macOS) notification. Clicking it brings you to the Waitwell tab.
// It's silent when the chime is on, so you don't hear two sounds.
const notificationTabs = new Map(); // notification id -> Waitwell tab id

const showDesktopNotification = async (ticket, { silent, tabId }) => {
    const id = await chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icon.png',
        title: 'Ticket accepted',
        message: messageFor(ticket),
        priority: 2,
        silent
    });
    if (tabId) notificationTabs.set(id, tabId);
};

chrome.notifications.onClicked.addListener(async (id) => {
    const tabId = notificationTabs.get(id);
    notificationTabs.delete(id);
    chrome.notifications.clear(id);
    if (!tabId) return;
    try {
        const tab = await chrome.tabs.update(tabId, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
    } catch (error) { /* tab was closed */ }
});
chrome.notifications.onClosed.addListener((id) => notificationTabs.delete(id));

// Teams "Workflows" webhook (Post to a chat/channel when a webhook request is received).
const postToTeams = async (url, ticket) => {
    const text = messageFor(ticket);
    const body = {
        type: 'message',
        text,
        attachments: [{
            contentType: 'application/vnd.microsoft.card.adaptive',
            content: {
                $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
                type: 'AdaptiveCard',
                version: '1.4',
                body: [{ type: 'TextBlock', text, wrap: true, weight: 'Bolder', size: 'Medium' }]
            }
        }]
    };
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`Teams returned ${response.status}`);
};

const handleAccepted = async (ticket, tabId) => {
    const settings = await getSettings();
    const errors = [];
    await recordCall(ticket).catch(() => {});
    if (settings.sound) await playChime().catch((error) => errors.push(`sound: ${error.message}`));
    if (settings.desktop) {
        await showDesktopNotification(ticket, { silent: settings.sound, tabId })
            .catch((error) => errors.push(`desktop notification: ${error.message}`));
    }
    if (settings.teams && settings.teamsUrl) {
        await postToTeams(settings.teamsUrl, ticket).catch((error) => errors.push(`teams: ${error.message}`));
    }
    await chrome.storage.local.set({ lastError: errors.join('; '), lastAlert: { text: messageFor(ticket), at: Date.now() } });
    return errors;
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'ticket-accepted') {
        handleAccepted(message.ticket, _sender.tab && _sender.tab.id);
    } else if (message.type === 'board-update' && _sender.tab) {
        chrome.storage.session.set({ board: message.board, boardTab: _sender.tab.id });
    } else if (message.type === 'open-dashboard') {
        openDashboard();
    } else if (message.type === 'dash-command') {
        relayToWaitwell(message.command).then(sendResponse);
        return true;
    } else if (message.type === 'keep-tab-awake' && _sender.tab) {
        // Stop Chrome's Memory Saver from discarding the Waitwell tab while it sits in the background.
        chrome.tabs.update(_sender.tab.id, { autoDiscardable: false }).catch(() => {});
    } else if (message.type === 'test-alert') {
        // From the popup: run everything with a fake ticket and report errors back.
        handleAccepted({ student: 'Test Student', rep: 'Test Rep', table: 'X-Table 1 - A', stu: '', test: true })
            .then((errors) => sendResponse({ errors }));
        return true;
    }
});

// Waitwell tab closed: clear its data so the dashboard says "Waiting for Waitwell…".
chrome.tabs.onRemoved.addListener(async (tabId) => {
    const { boardTab } = await chrome.storage.session.get('boardTab');
    if (tabId === boardTab) await chrome.storage.session.remove(['board', 'boardTab']);
});
