'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const network = require('../out/services/networkService');
const oauth = require('../out/services/oauthService');
const callbacks = require('../out/services/oauthCallbackServer');
const accounts = require('../out/services/accountService');

const variableNames = [
    'ANTI_QUOTA_DATA_DIR', 'ANTI_QUOTA_GOOGLE_CLIENT_ID', 'ANTI_QUOTA_GOOGLE_CLIENT_SECRET',
];
const originalEnvironment = variableNames.map(name => [name, process.env[name]]);
const originalRequest = network.requestHttps;
const originalStartCallback = callbacks.startCallbackServer;
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-quota-oauth-config-'));
const configPath = path.join(temporaryDirectory, 'oauth-client.json');
const fileConfig = { client_id: 'file-client-id', client_secret: 'file-client-secret' };
const environmentConfig = { client_id: 'environment-client-id', client_secret: 'environment-client-secret' };
const requests = [];

function clearClientEnvironment() {
    delete process.env.ANTI_QUOTA_GOOGLE_CLIENT_ID;
    delete process.env.ANTI_QUOTA_GOOGLE_CLIENT_SECRET;
}

function writeConfig(value) {
    fs.writeFileSync(configPath, JSON.stringify(value));
}

(async () => {
    process.env.ANTI_QUOTA_DATA_DIR = temporaryDirectory;
    clearClientEnvironment();
    network.requestHttps = async (url, options, body) => {
        requests.push({ url, options, body: new URLSearchParams(body) });
        return { status: 200, headers: {}, body: JSON.stringify({
            access_token: 'test-access-token', expires_in: 3600, token_type: 'Bearer',
        }) };
    };

    assert.throws(() => oauth.getAuthUrl(), /尚未配置 Google OAuth/);
    await assert.rejects(oauth.exchangeCode('test-code'), /尚未配置 Google OAuth/);
    await assert.rejects(oauth.refreshAccessToken('test-refresh'), /尚未配置 Google OAuth/);
    assert.strictEqual(requests.length, 0, '缺少配置时不能发出网络请求');

    let listenersStarted = 0;
    callbacks.startCallbackServer = async () => { listenersStarted++; return 'test-code'; };
    await assert.rejects(accounts.startOAuthFlow(), /尚未配置 Google OAuth/);
    assert.strictEqual(listenersStarted, 0, '缺配置时不能占用回调端口或等待登录');
    callbacks.startCallbackServer = originalStartCallback;

    writeConfig(fileConfig);
    assert.deepStrictEqual(oauth.getOAuthClientConfig(), fileConfig);
    const authUrl = new URL(oauth.getAuthUrl());
    assert.strictEqual(authUrl.origin, 'https://accounts.google.com');
    assert.strictEqual(authUrl.searchParams.get('client_id'), fileConfig.client_id);
    assert.strictEqual(authUrl.searchParams.get('redirect_uri'), 'http://localhost:19823/oauth-callback');
    assert.strictEqual(authUrl.searchParams.has('client_secret'), false, '浏览器URL不得携带client secret');

    await oauth.exchangeCode('test-code');
    assert.strictEqual(requests[0].url, 'https://oauth2.googleapis.com/token');
    assert.strictEqual(requests[0].body.get('client_id'), fileConfig.client_id);
    assert.strictEqual(requests[0].body.get('client_secret'), fileConfig.client_secret);
    assert.strictEqual(requests[0].body.get('code'), 'test-code');

    // 长期运行的服务应读到新的共享文件，不能缓存旧客户端。
    writeConfig({ installed: environmentConfig });
    await oauth.refreshAccessToken('test-refresh');
    assert.strictEqual(requests[1].body.get('client_id'), environmentConfig.client_id);
    assert.strictEqual(requests[1].body.get('client_secret'), environmentConfig.client_secret);
    assert.strictEqual(requests[1].body.get('refresh_token'), 'test-refresh');
    assert.strictEqual(requests[1].body.get('grant_type'), 'refresh_token');

    process.env.ANTI_QUOTA_GOOGLE_CLIENT_ID = ` ${fileConfig.client_id} `;
    process.env.ANTI_QUOTA_GOOGLE_CLIENT_SECRET = ` ${fileConfig.client_secret} `;
    fs.writeFileSync(configPath, 'invalid JSON');
    assert.deepStrictEqual(oauth.getOAuthClientConfig(), fileConfig, '完整环境变量对优先于文件');
    delete process.env.ANTI_QUOTA_GOOGLE_CLIENT_SECRET;
    writeConfig(environmentConfig);
    assert.throws(() => oauth.getOAuthClientConfig(), /请同时设置/,
        '不能将环境变量ID和文件中的其他客户端secret拼成一对');
    clearClientEnvironment();

    for (const invalid of [null, [], {}, { client_id: 'id' },
        { client_id: 1, client_secret: 'secret' },
        { client_id: 'YOUR_CLIENT_ID', client_secret: 'YOUR_CLIENT_SECRET' },
        { installed: { client_id: 'id', client_secret: 'bad\nsecret' } }]) {
        writeConfig(invalid);
        assert.throws(() => oauth.getOAuthClientConfig(), /OAuth 客户端配置无效/);
    }

    fs.writeFileSync(configPath, '{"client_secret":"private-test-marker", invalid');
    assert.throws(() => oauth.getOAuthClientConfig(), error =>
        /不是有效 JSON/.test(error.message) && !error.message.includes('private-test-marker'));
    fs.writeFileSync(configPath, 'A'.repeat(64 * 1024 + 1));
    assert.throws(() => oauth.getOAuthClientConfig(), /上限 64 KiB/);
    fs.writeFileSync(configPath, '\uFEFF' + JSON.stringify(fileConfig), 'utf8');
    assert.deepStrictEqual(oauth.getOAuthClientConfig(), fileConfig, '兼容Windows带BOM配置');
    fs.unlinkSync(configPath);
    assert.throws(() => oauth.getOAuthClientConfig(), /尚未配置 Google OAuth/,
        '文件移除后不能继续使用缓存或内置客户端');
    assert.strictEqual(requests.length, 2, '失败路径不能发送请求');
    console.log('OAuth local configuration regression checks passed.');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    network.requestHttps = originalRequest;
    callbacks.startCallbackServer = originalStartCallback;
    for (const [name, value] of originalEnvironment) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});
