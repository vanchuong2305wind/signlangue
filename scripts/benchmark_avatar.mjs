const args = process.argv.slice(2);
const positional = args.filter(argument => !argument.startsWith('--'));
const appUrl = positional[0] || 'http://127.0.0.1:5173/translate';
const debugUrl = positional[1] || 'http://127.0.0.1:9222';
const coldStart = args.includes('--cold');
const mbps = Number(args.find(argument => argument.startsWith('--mbps='))?.split('=')[1] || 0);
const latencyMs = Number(args.find(argument => argument.startsWith('--latency='))?.split('=')[1] || 0);

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const tabs = await fetch(`${debugUrl}/json`).then(response => response.json());
const tab = tabs.find(item => item.type === 'page' && item.url.startsWith(appUrl));
if (!tab) throw new Error(`No Chrome tab found for ${appUrl}`);

const socket = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
});

let commandId = 0;
const pending = new Map();
const browserMessages = [];
socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.consoleAPICalled') {
        browserMessages.push({
            type: message.params.type,
            text: message.params.args
                .map(item => item.value ?? item.description ?? '')
                .join(' '),
        });
    }
    if (!message.id) return;
    const handler = pending.get(message.id);
    if (!handler) return;
    pending.delete(message.id);
    if (message.error) handler.reject(new Error(message.error.message));
    else handler.resolve(message.result);
});

function command(method, params = {}) {
    commandId += 1;
    const id = commandId;
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression) {
    const response = await command('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
    });
    if (response.exceptionDetails) {
        throw new Error(response.exceptionDetails.text || 'Browser evaluation failed');
    }
    return response.result.value;
}

async function waitFor(expression, timeoutMs = 30_000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        const value = await evaluate(expression);
        if (value) return value;
        await delay(50);
    }
    throw new Error(`Timed out waiting for: ${expression}`);
}

await command('Runtime.enable');
if (coldStart) {
    await command('Network.enable');
    await command('Network.clearBrowserCache');
    if (mbps > 0 || latencyMs > 0) {
        await command('Network.emulateNetworkConditions', {
            offline: false,
            latency: latencyMs,
            downloadThroughput: mbps > 0 ? mbps * 125_000 : -1,
            uploadThroughput: mbps > 0 ? mbps * 125_000 : -1,
            connectionType: 'other',
        });
    }
    await command('Page.navigate', { url: appUrl });
}
await waitFor(`document.querySelector('#text-input-field') !== null`);

const modelStatusExpression = `(() => {
    const text = document.body.textContent;
    if (text.includes('Avatar VRM toàn thân sẵn sàng')) return 'vrm';
    if (text.includes('Mô hình tay sẵn sàng')) return 'fallback';
    return '';
})()`;
let modelStatus = coldStart ? 'loading' : await waitFor(modelStatusExpression);

await evaluate(`(() => {
    window.__avatarMotion = null;
    window.addEventListener('avatar:first-motion', event => {
        window.__avatarMotion = event.detail;
    }, { once: true });
    const button = [...document.querySelectorAll('button')]
        .find(item => item.textContent.includes('3D Avatar'));
    button.click();
    return true;
})()`);
await delay(100);

await evaluate(`(() => {
    const input = document.querySelector('#text-input-field');
    const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
    ).set;
    setter.call(input, 'tôi yêu bạn');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
})()`);
await delay(50);
await evaluate(`document.querySelector('#text-submit-btn').click()`);

const firstMotion = await waitFor(`window.__avatarMotion`, 10_000);
if (coldStart) modelStatus = await waitFor(modelStatusExpression);
const metrics = await evaluate(`(() => ({
    measuredDuration: performance.getEntriesByName('avatar-time-to-first-motion').at(-1)?.duration,
    resources: performance.getEntriesByType('resource')
        .filter(item => item.name.includes('/models/avatar.vrm') ||
            item.name.includes('/api/text-to-signs') ||
            item.name.includes('/api/landmarks/'))
        .map(item => ({
            name: item.name.replace(location.origin, ''),
            duration: item.duration,
            transferSize: item.transferSize,
            encodedBodySize: item.encodedBodySize,
            decodedBodySize: item.decodedBodySize,
        })),
}))()`);

console.log(JSON.stringify({
    targetMs: 2000,
    targetMet: firstMotion.duration < 2000,
    network: mbps > 0 ? { mbps, latencyMs } : 'native',
    modelStatus,
    firstMotion,
    ...metrics,
    browserMessages: browserMessages.filter(item =>
        item.type === 'error' || item.text.includes('AvatarScene3D')),
}, null, 2));
if (mbps > 0 || latencyMs > 0) {
    await command('Network.emulateNetworkConditions', {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
        connectionType: 'none',
    });
}
socket.close();
if (firstMotion.duration >= 2000) process.exitCode = 1;
