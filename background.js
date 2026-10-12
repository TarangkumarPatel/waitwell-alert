const DEFAULTS = { sound: true, teams: false, teamsUrl: '' };

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

const handleAccepted = async (ticket) => {
    const settings = await getSettings();
    const errors = [];
    if (settings.sound) await playChime().catch((error) => errors.push(`sound: ${error.message}`));
    if (settings.teams && settings.teamsUrl) {
        await postToTeams(settings.teamsUrl, ticket).catch((error) => errors.push(`teams: ${error.message}`));
    }
    await chrome.storage.local.set({ lastError: errors.join('; '), lastAlert: { text: messageFor(ticket), at: Date.now() } });
    return errors;
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'ticket-accepted') {
        handleAccepted(message.ticket);
    } else if (message.type === 'keep-tab-awake' && _sender.tab) {
        // Stop Chrome's Memory Saver from discarding the Waitwell tab while it sits in the background.
        chrome.tabs.update(_sender.tab.id, { autoDiscardable: false }).catch(() => {});
    } else if (message.type === 'test-alert') {
        // From the popup: run everything with a fake ticket and report errors back.
        handleAccepted({ student: 'Test Student', rep: 'Test Rep', table: 'X-Table 0 - A', stu: '' })
            .then((errors) => sendResponse({ errors }));
        return true;
    }
});
