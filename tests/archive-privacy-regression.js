#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { TextDecoder } = require('util');
const yauzl = require('yauzl');

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
const MAX_TEXT_ENTRY_BYTES = 16 * 1024 * 1024;
const SQLITE3_SHA256 = '3cf89763987cb010fbb888c17a0a431ad9b827918b1d6d6e7941704393d7aca4';

// These exact npm-managed files contain their upstream maintainers' public email
// addresses. Any byte change removes the exception and makes the archive fail.
const AUDITED_THIRD_PARTY_EMAIL_FILES = new Map([
    ['node_modules/agent-base/LICENSE', '8d8c55319c7729d57be811c747452636688d54f19701ee0752b6b15ad3771d9a'],
    ['node_modules/agent-base/package.json', '7a08cb2fe1d2b788e0a7bf6a9b7597dbeeeae804698c2fbd15de786d284d327c'],
    ['node_modules/debug/LICENSE', '3a61c6c96caf5c1d9b623fb9b04c822b783dfcb78aa7e49c76a3f643e6ed7f95'],
    ['node_modules/debug/package.json', 'ea8e33d63fe5f3a4c36609b6c3df8e2ef1f8b8ba2fc3a2e1e53cb27291f384af'],
    ['node_modules/debug/README.md', '486cb669048bd5014adf9ea117e27a45c4e61b0e668f464c724273beb8170797'],
    ['node_modules/https-proxy-agent/LICENSE', '8d8c55319c7729d57be811c747452636688d54f19701ee0752b6b15ad3771d9a'],
    ['node_modules/https-proxy-agent/package.json', 'b08c1977d38f14f4be7fb5be33aab545e3e5a6e2e12100733a6ad97dec995206'],
    ['node_modules/ip-address/package.json', '019ef45b7c85ad49004eb7e9115e7ca73845ee3421cce141b2a8bde2ae4c92bc'],
    ['node_modules/proxy-from-env/LICENSE', 'f55828df4b8752c48e765a806465b76a103e3cb363379c569b15a1df2ba2d79e'],
    ['node_modules/proxy-from-env/package.json', 'a99da95a16d2dcc5e8006883f53721cc6224a8706863b20bf0a334170a1fe0ca'],
    ['node_modules/socks-proxy-agent/LICENSE', '8d8c55319c7729d57be811c747452636688d54f19701ee0752b6b15ad3771d9a'],
    ['node_modules/socks-proxy-agent/package.json', '5667d50ea8b62c802757a3a2737a6515edbae3129bb3ef0980ca5d15c91ed99f'],
    ['node_modules/socks-proxy-agent/README.md', '372394886b8b5100e7a03ac156f778865ba6a01a364dbee22d97b18c06524f59'],
]);

const FORBIDDEN_DIAGNOSTIC_FILES = new Set([
    'trajectory_blob.b64',
    'analyze_blob.py',
    'debug_reset_time.js',
    'simulate_restore.js',
    'verify_extraction.js',
    'test_restore.ts',
    'bugment-custom-panel.html',
]);

const ACCOUNT_STATE_FILES = new Set([
    'scm-update-restore.json',
    '.accounts.lock',
    'antigravity-oauth-token',
    'accounts.json',
    'accounts.latest.json',
    'oauth-client.json',
    'service-start.lock',
    'service-token',
    'service.pid',
    'state_backup.json',
    'switch_pending.json',
    'update.lock',
    'unsafe-install.json',
]);

const HIGH_CONFIDENCE_SECRET_RULES = [
    ['private-key', /-----BEGIN (?:DSA |EC |ENCRYPTED |OPENSSH |PGP |RSA )?PRIVATE KEY-----/],
    ['github-token', /(?:^|[^A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{80,255})(?:$|[^A-Za-z0-9_])/],
    ['aws-access-key', /(?:^|[^A-Z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?:$|[^A-Z0-9])/],
    ['google-access-token', /(?:^|[^A-Za-z0-9_-])ya29\.[A-Za-z0-9_-]{20,}(?:$|[^A-Za-z0-9_-])/],
    ['google-refresh-token', /(?:^|[^A-Za-z0-9_-])1\/\/[A-Za-z0-9_-]{20,}(?:$|[^A-Za-z0-9_-])/],
    ['google-oauth-code', /(?:^|[^A-Za-z0-9_-])4\/0A[A-Za-z0-9_-]{30,}(?:$|[^A-Za-z0-9_-])/],
    ['google-api-key', /(?:^|[^A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?:$|[^A-Za-z0-9_-])/],
    ['google-oauth-client-secret', /(?:^|[^A-Za-z0-9_-])GOCSPX-[A-Za-z0-9_-]{20,64}(?:$|[^A-Za-z0-9_-])/],
    ['google-oauth-client-id', /(?:^|[^A-Za-z0-9_.-])\d{6,21}-[A-Za-z0-9_-]{20,64}\.apps\.googleusercontent\.com(?:$|[^A-Za-z0-9_.-])/],
    ['npm-token', /(?:^|[^A-Za-z0-9_])npm_[A-Za-z0-9]{36}(?:$|[^A-Za-z0-9_])/],
    ['gitlab-token', /(?:^|[^A-Za-z0-9_-])glpat-[A-Za-z0-9_-]{20,}(?:$|[^A-Za-z0-9_-])/],
    ['slack-token', /(?:^|[^A-Za-z0-9-])xox[baprs]-[A-Za-z0-9-]{20,}(?:$|[^A-Za-z0-9-])/],
    ['openai-or-anthropic-key', /(?:^|[^A-Za-z0-9_-])sk-(?:proj-|ant-api\d{2}-)?[A-Za-z0-9_-]{32,}(?:$|[^A-Za-z0-9_-])/],
    ['stripe-live-secret', /(?:^|[^A-Za-z0-9_])sk_live_[A-Za-z0-9]{20,}(?:$|[^A-Za-z0-9_])/],
    ['jwt', /(?:^|[^A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:$|[^A-Za-z0-9_-])/],
];

const CREDENTIALED_URL_PATTERN = /\b(?:https?|socks5h?):\/\/([^\s/@:]+):([^\s/@]+)@(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9.-]+)(?::\d+)?/gi;
const TEST_CREDENTIAL_URLS = new Set([
    JSON.stringify(['proxy-user', 'proxy-secret', '127.0.0.1']),
]);

const EMAIL_PATTERN = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+/gi;
const WINDOWS_USER_PATH_PATTERN = /(?:\b[A-Z]:)?[\\/]+Users[\\/]+([^\\/\s"'`<>]+)(?=[\\/])/gi;
const UNIX_USER_PATH_PATTERN = /[\\/]+(?:home|Users)[\\/]+([^\\/\s"'`<>]+)(?=[\\/])/gi;
const GENERIC_USER_NAMES = new Set([
    'admin', 'administrator', 'alice', 'bob', 'default', 'defaultuser0', 'dev',
    'developer', 'example', 'foo', 'home', 'name', 'public', 'root', 'runner',
    'sample', 'test', 'user', 'username', 'your-name', 'your_name', 'yourname',
]);

function usage() {
    console.error('Usage: node tests/archive-privacy-regression.js <package.vsix> <package.tgz>');
    process.exitCode = 2;
}

function normalizeEntryName(entryName) {
    return String(entryName).replace(/\\/g, '/').replace(/^\.\//, '');
}

function shouldInspectEntryContent(entryName) {
    return normalizeEntryName(entryName).length > 0;
}

function looksLikeText(buffer) {
    if (buffer.includes(0)) return false;
    const sampleLength = Math.min(buffer.length, 8192);
    let controls = 0;
    for (let index = 0; index < sampleLength; index += 1) {
        const byte = buffer[index];
        if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) controls += 1;
    }
    return sampleLength === 0 || controls / sampleLength < 0.02;
}

function decodeText(buffer) {
    if (!looksLikeText(buffer)) return null;
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
        return null;
    }
}

function extractBinaryStrings(buffer) {
    const strings = [];
    const ascii = buffer.toString('latin1');
    for (const match of ascii.matchAll(/[\x20-\x7e]{6,}/g)) strings.push(match[0]);

    let utf16 = '';
    for (let offset = 0; offset + 1 < buffer.length; offset += 2) {
        const code = buffer[offset] | (buffer[offset + 1] << 8);
        if (code >= 0x20 && code <= 0x7e) {
            utf16 += String.fromCharCode(code);
        } else {
            if (utf16.length >= 6) strings.push(utf16);
            utf16 = '';
        }
    }
    if (utf16.length >= 6) strings.push(utf16);
    return strings.join('\n');
}

function isAuditedSqliteBinary(entryName, buffer) {
    const normalized = normalizeEntryName(entryName).toLowerCase();
    if (!new Set([
        'scripts/sqlite3.exe',
        'extension/scripts/sqlite3.exe',
        'package/scripts/sqlite3.exe',
    ]).has(normalized)) {
        return false;
    }
    return crypto.createHash('sha256').update(buffer).digest('hex') === SQLITE3_SHA256;
}

function isAuditedThirdPartyEmailFile(entryName, buffer) {
    const normalized = normalizeEntryName(entryName);
    const segments = normalized.split('/');
    const markerIndex = segments.indexOf('node_modules');
    if (markerIndex < 0) return false;
    const packagePath = segments.slice(markerIndex).join('/');
    const expected = AUDITED_THIRD_PARTY_EMAIL_FILES.get(packagePath);
    return !!expected && crypto.createHash('sha256').update(buffer).digest('hex') === expected;
}

function currentUserMarkers() {
    const candidates = new Set();
    try {
        candidates.add(os.userInfo().username);
    } catch {
        // A missing OS user record must not make the archive scan fail.
    }
    candidates.add(process.env.USERNAME);
    candidates.add(process.env.USER);

    return [...candidates]
        .filter(value => typeof value === 'string')
        .map(value => value.trim())
        .filter(value => value.length >= 4 && !GENERIC_USER_NAMES.has(value.toLowerCase()));
}

const CURRENT_USER_MARKERS = currentUserMarkers();

function isLikelyPersonalEmail(email) {
    const normalized = email.toLowerCase();
    const separator = normalized.lastIndexOf('@');
    const localPart = normalized.slice(0, separator);
    const domain = normalized.slice(separator + 1);
    const normalizedLocalPart = localPart.replace(/^\/+/, '');

    if (['example.com', 'example.net', 'example.org', 'invalid', 'localhost'].includes(domain)) return false;
    if (domain.endsWith('.example.com') || domain.endsWith('.example.org')) return false;
    if (net.isIP(domain)) return false;
    if (domain === 'github.com' && normalizedLocalPart === 'git') return false;
    if (domain === 'users.noreply.github.com' || localPart.includes('noreply')) return false;
    return true;
}

function decodeBase64Length(value) {
    const compact = value.replace(/\s/g, '');
    if (!compact || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact)) return null;

    const unpadded = compact.replace(/=+$/, '');
    const standard = unpadded.replace(/-/g, '+').replace(/_/g, '/');
    if (standard.length % 4 === 1) return null;
    const padded = standard + '='.repeat((4 - (standard.length % 4)) % 4);
    try {
        const decoded = Buffer.from(padded, 'base64');
        return decoded.toString('base64').replace(/=+$/, '') === standard
            ? decoded.length
            : null;
    } catch {
        return null;
    }
}

function isValidLargeBase64(value) {
    const compact = value.replace(/\s/g, '');
    const decodedLength = decodeBase64Length(compact);
    return compact.replace(/=+$/, '').length >= 2048
        && decodedLength !== null
        && decodedLength >= 1024;
}

function containsLargeEncodedRegion(parts) {
    const compact = parts.join('').replace(/[ \t]/g, '');
    if (compact.length < 2048) return false;
    const chunks = compact.match(/[A-Za-z0-9+/_-]+={0,2}/g);
    if (!chunks || chunks.join('') !== compact) return false;

    let encodedCharacters = 0;
    let decodedBytes = 0;
    for (const chunk of chunks) {
        const decodedLength = decodeBase64Length(chunk);
        if (decodedLength === null) return false;
        encodedCharacters += chunk.length;
        decodedBytes += decodedLength;
    }
    return encodedCharacters >= 2048 && decodedBytes >= 1024;
}

function replaceHtmlControlEntities(text, replacement) {
    return text.replace(
        /(?:&#(?:0*10|0*13|x0*a|x0*d);|&(?:NewLine|Tab);)/gi,
        replacement
    );
}

function containsQuotedBase64Fragments(text) {
    const quotedFragment = /(["'`])([A-Za-z0-9+/_-]{4,}={0,2})\1/g;
    let parts = [];
    let previousEnd = -1;
    const flush = () => {
        const bodyParts = parts.length > 1 ? parts.slice(0, -1) : parts;
        const bodyLengths = bodyParts.map(part => part.length);
        const shortest = bodyLengths.length > 0 ? Math.min(...bodyLengths) : 0;
        const longest = bodyLengths.length > 0 ? Math.max(...bodyLengths) : 0;
        const tailLength = parts.length > 0 ? parts[parts.length - 1].length : 0;
        const hasConsistentFragmentShape = parts.length >= 16
            && (shortest >= 64 || longest - shortest <= 1)
            && tailLength <= longest;
        const candidate = hasConsistentFragmentShape && containsLargeEncodedRegion(parts);
        parts = [];
        return candidate;
    };

    for (const match of text.matchAll(quotedFragment)) {
        if (previousEnd >= 0) {
            const separator = text.slice(previousEnd, match.index);
            if (!/^[\s,\[\]+]*$/.test(separator)) {
                if (flush()) return true;
            }
        }
        parts.push(match[2]);
        previousEnd = match.index + match[0].length;
    }
    return flush();
}

function containsExplicitlySeparatedBase64(text, isAllowedSeparator) {
    const fragment = /[A-Za-z0-9+/_-]{4,}={0,2}/g;
    let parts = [];
    let previousEnd = -1;
    const flush = () => {
        const candidate = containsLargeEncodedRegion(parts);
        parts = [];
        return candidate;
    };

    for (const match of text.matchAll(fragment)) {
        if (previousEnd >= 0
            && !isAllowedSeparator(text.slice(previousEnd, match.index))) {
            if (flush()) return true;
        }
        parts.push(match[0]);
        previousEnd = match.index + match[0].length;
    }
    return flush();
}

function isHtmlControlEntitySeparator(value) {
    let foundEntity = false;
    const remainder = replaceHtmlControlEntities(value, () => {
        foundEntity = true;
        return '';
    });
    return foundEntity && /^\s*$/.test(remainder);
}

function isFormFeedSeparator(value) {
    return /[\f\v]/.test(value) && /^\s+$/.test(value);
}

function containsContinuousLargeEncodedBlob(text) {
    const continuous = /(?:^|[^A-Za-z0-9+/_=-])([A-Za-z0-9+/_-]{2048,}={0,2})(?=$|[^A-Za-z0-9+/_=-])/g;
    for (const match of text.matchAll(continuous)) {
        if (isValidLargeBase64(match[1])) return true;
    }
    return false;
}

function containsLargeEncodedBlob(text) {
    if (containsContinuousLargeEncodedBlob(text)) return true;

    if (containsQuotedBase64Fragments(text)) return true;

    if (containsExplicitlySeparatedBase64(text, isHtmlControlEntitySeparator)
        || containsExplicitlySeparatedBase64(text, isFormFeedSeparator)) {
        return true;
    }

    const separatorNormalizedText = replaceHtmlControlEntities(text, '\n');
    let wrappedParts = [];
    const flush = () => {
        const candidate = containsLargeEncodedRegion(wrappedParts);
        wrappedParts = [];
        return candidate;
    };
    for (const line of separatorNormalizedText.split(/\r\n|[\n\r\f\v]/)) {
        const trimmed = line.trim();
        const unwrapped = trimmed.replace(/^(?:#{1,6}|>)\s+/, '');
        const compactLine = unwrapped.replace(/[ \t]/g, '');
        if (!compactLine && wrappedParts.length > 0) continue;
        if (compactLine && /^[A-Za-z0-9+/_=-]+$/.test(compactLine)) {
            wrappedParts.push(unwrapped);
            continue;
        }
        if (flush()) return true;
    }
    return flush();
}

function isBase64DataByte(byte) {
    return (byte >= 0x41 && byte <= 0x5a)
        || (byte >= 0x61 && byte <= 0x7a)
        || (byte >= 0x30 && byte <= 0x39)
        || byte === 0x2b
        || byte === 0x2f
        || byte === 0x3d
        || byte === 0x2d
        || byte === 0x5f;
}

function isBinaryBase64SeparatorByte(byte) {
    return byte === 0x00
        || byte === 0x0a
        || byte === 0x0b
        || byte === 0x0c
        || byte === 0x0d;
}

function containsBinaryEncodedBlob(buffer) {
    let continuousCharacters = 0;
    for (const byte of buffer) {
        if (isBase64DataByte(byte)) {
            continuousCharacters += 1;
            if (continuousCharacters >= 2048 && continuousCharacters % 4 === 0) return true;
        } else {
            continuousCharacters = 0;
        }
    }

    let minimumFragmentLength = 0;
    let maximumFragmentLength = 0;
    let currentFragmentLength = 0;
    let encodedCharacters = 0;
    let completedFragments = 0;

    const reset = () => {
        minimumFragmentLength = 0;
        maximumFragmentLength = 0;
        currentFragmentLength = 0;
        encodedCharacters = 0;
        completedFragments = 0;
    };
    const isLargeCandidate = includeTail => {
        const tailLength = includeTail ? currentFragmentLength : 0;
        const total = encodedCharacters + tailLength;
        return minimumFragmentLength >= 4
            && maximumFragmentLength <= 128
            && (minimumFragmentLength === maximumFragmentLength || minimumFragmentLength >= 8)
            && completedFragments >= 16
            && (!includeTail || (tailLength > 0 && tailLength <= maximumFragmentLength))
            && total >= 2048;
    };

    for (const byte of buffer) {
        if (isBase64DataByte(byte)) {
            currentFragmentLength += 1;
            continue;
        }
        if (isBinaryBase64SeparatorByte(byte)) {
            if (currentFragmentLength === 0) continue;
            const nextMinimum = minimumFragmentLength === 0
                ? currentFragmentLength
                : Math.min(minimumFragmentLength, currentFragmentLength);
            const nextMaximum = Math.max(maximumFragmentLength, currentFragmentLength);
            const hasCompatibleWidth = minimumFragmentLength === 0
                || (nextMaximum - nextMinimum <= 1
                    && (nextMinimum === nextMaximum || nextMinimum >= 8));
            if (hasCompatibleWidth) {
                minimumFragmentLength = nextMinimum;
                maximumFragmentLength = nextMaximum;
                encodedCharacters += currentFragmentLength;
                completedFragments += 1;
            } else {
                minimumFragmentLength = currentFragmentLength;
                maximumFragmentLength = currentFragmentLength;
                encodedCharacters = currentFragmentLength;
                completedFragments = 1;
            }
            currentFragmentLength = 0;
            if (isLargeCandidate(false)) return true;
            continue;
        }
        if (isLargeCandidate(true)) return true;
        reset();
    }
    return isLargeCandidate(true);
}

function containsCredentialedUrl(text) {
    CREDENTIALED_URL_PATTERN.lastIndex = 0;
    let match;
    while ((match = CREDENTIALED_URL_PATTERN.exec(text)) !== null) {
        const host = match[3].replace(/^\[|\]$/g, '').toLowerCase();
        if (!TEST_CREDENTIAL_URLS.has(JSON.stringify([match[1], match[2], host]))) return true;
    }
    return false;
}

function containsPersonalAbsolutePath(text) {
    for (const pattern of [WINDOWS_USER_PATH_PATTERN, UNIX_USER_PATH_PATTERN]) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(text)) !== null) {
            const userName = match[1].toLowerCase();
            if (!GENERIC_USER_NAMES.has(userName)
                && !userName.includes('$')
                && !userName.includes('%')
                && !userName.includes('{')) {
                return true;
            }
        }
    }
    return false;
}

function redactEntryName(entryName) {
    let redacted = normalizeEntryName(entryName);
    for (const marker of CURRENT_USER_MARKERS) {
        redacted = redacted.replace(new RegExp(escapeRegExp(marker), 'gi'), '[current-user]');
    }
    redacted = redacted.replace(EMAIL_PATTERN, '[email]');
    redacted = redacted.replace(WINDOWS_USER_PATH_PATTERN, match => match.replace(/Users[\\/]+[^\\/]+/i, 'Users/[user]'));
    redacted = redacted.replace(UNIX_USER_PATH_PATTERN, match => match.replace(/(home|Users)[\\/]+[^\\/]+/i, '$1/[user]'));
    return redacted;
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createFindingCollector() {
    const findings = [];
    const seen = new Set();

    return {
        add(archive, entry, category) {
            const normalizedEntry = normalizeEntryName(entry) || '[archive-root]';
            const key = `${archive}\0${normalizedEntry}\0${category}`;
            if (seen.has(key)) return;
            seen.add(key);
            findings.push({ archive, entry: normalizedEntry, category });
        },
        all() {
            return findings;
        },
    };
}

function inspectEntryPath(archive, entryName, collector) {
    const normalized = normalizeEntryName(entryName);
    const lower = normalized.toLowerCase();
    const basename = path.posix.basename(lower);
    const segments = lower.split('/').filter(Boolean);

    if (FORBIDDEN_DIAGNOSTIC_FILES.has(basename)) {
        collector.add(archive, normalized, 'forbidden-diagnostic-file');
    }
    if (basename.endsWith('.b64')) {
        collector.add(archive, normalized, 'forbidden-base64-artifact');
    }
    if (ACCOUNT_STATE_FILES.has(basename)
        || segments.some(segment => ACCOUNT_STATE_FILES.has(segment))
        || /^accounts-\d{8}t\d{6}z-\d+\.json$/.test(basename)
        || /^accounts(?:\.latest)?\.json(?:\.[^/]*)?\.tmp$/.test(basename)
        || /^accounts-[^/]+\.json(?:\.[^/]*)?\.tmp$/.test(basename)
        || /^antigravity-oauth-token\.tmp-[^/]+$/.test(basename)
        || segments.some(segment => /^service-start\.lock\.(?:release|stale)-/.test(segment))
        || segments.includes('.anti-quota')
        || lower.includes('/user/globalstorage/')) {
        collector.add(archive, normalized, 'account-state-path');
    }
    if (segments.some(segment => /^\.env(?:\.|$)/.test(segment))
        || /\.(?:key|p12|pem|pfx)$/.test(basename)) {
        collector.add(archive, normalized, 'forbidden-secret-file');
    }
    if (lower.startsWith('/')
        || /^[a-z]:\//i.test(lower)
        || segments.includes('..')) {
        collector.add(archive, normalized, 'unsafe-archive-path');
    }
}

function inspectText(archive, entryName, buffer, collector) {
    if (!shouldInspectEntryContent(entryName)) return;
    if (buffer.length > MAX_TEXT_ENTRY_BYTES) {
        collector.add(archive, entryName, 'content-entry-too-large-to-scan');
        return;
    }

    let text = decodeText(buffer);
    let binaryEncodedBlob = false;
    let binaryStringsOnly = false;
    if (text === null) {
        if (isAuditedSqliteBinary(entryName, buffer)) return;
        binaryEncodedBlob = containsBinaryEncodedBlob(buffer);
        text = extractBinaryStrings(buffer);
        if (!text && !binaryEncodedBlob) return;
        binaryStringsOnly = true;
    }

    const secretScanText = replaceHtmlControlEntities(text, '');
    for (const [category, pattern] of HIGH_CONFIDENCE_SECRET_RULES) {
        if (pattern.test(secretScanText)) collector.add(archive, entryName, category);
    }

    for (const marker of CURRENT_USER_MARKERS) {
        if (text.toLowerCase().includes(marker.toLowerCase())) {
            collector.add(archive, entryName, 'current-user-marker');
            break;
        }
    }

    if (binaryEncodedBlob || (!binaryStringsOnly && containsLargeEncodedBlob(text))) {
        collector.add(archive, entryName, 'large-encoded-blob');
    }
    if (containsCredentialedUrl(text)) {
        collector.add(archive, entryName, 'credentialed-url');
    }

    EMAIL_PATTERN.lastIndex = 0;
    let emailMatch;
    while ((emailMatch = EMAIL_PATTERN.exec(text)) !== null) {
        if (isLikelyPersonalEmail(emailMatch[0])) {
            if (!isAuditedThirdPartyEmailFile(entryName, buffer)) {
                collector.add(archive, entryName, 'personal-email');
            }
            break;
        }
    }
    if (containsPersonalAbsolutePath(text)) {
        collector.add(archive, entryName, 'absolute-user-path');
    }
}

function validateArchiveFile(filePath, expectedExtension) {
    if (path.extname(filePath).toLowerCase() !== expectedExtension) {
        throw new Error('unexpected-extension');
    }
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_ARCHIVE_BYTES) {
        throw new Error('invalid-archive-size');
    }
}

function scanVsix(filePath, archive, collector) {
    return new Promise((resolve, reject) => {
        yauzl.open(filePath, {
            lazyEntries: true,
            strictFileNames: true,
            validateEntrySizes: true,
        }, (openError, zipFile) => {
            if (openError || !zipFile) {
                reject(new Error('invalid-vsix'));
                return;
            }

            let totalUncompressed = 0;
            let finished = false;
            const fail = () => {
                if (finished) return;
                finished = true;
                try { zipFile.close(); } catch { /* ignore close failure */ }
                reject(new Error('invalid-vsix'));
            };

            zipFile.on('error', fail);
            zipFile.on('end', () => {
                if (finished) return;
                finished = true;
                resolve();
            });
            zipFile.on('entry', entry => {
                if (finished) return;
                const entryName = normalizeEntryName(entry.fileName);
                inspectEntryPath(archive, entryName, collector);

                if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) {
                    fail();
                    return;
                }
                totalUncompressed += entry.uncompressedSize;
                if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) {
                    fail();
                    return;
                }
                if (entryName.endsWith('/') || !shouldInspectEntryContent(entryName)) {
                    zipFile.readEntry();
                    return;
                }
                if (entry.uncompressedSize > MAX_TEXT_ENTRY_BYTES) {
                    collector.add(archive, entryName, 'content-entry-too-large-to-scan');
                    zipFile.readEntry();
                    return;
                }

                zipFile.openReadStream(entry, (streamError, stream) => {
                    if (streamError || !stream) {
                        fail();
                        return;
                    }
                    const chunks = [];
                    let bytesRead = 0;
                    stream.on('error', fail);
                    stream.on('data', chunk => {
                        bytesRead += chunk.length;
                        if (bytesRead > MAX_TEXT_ENTRY_BYTES) {
                            stream.destroy();
                            fail();
                            return;
                        }
                        chunks.push(chunk);
                    });
                    stream.on('end', () => {
                        if (finished) return;
                        inspectText(archive, entryName, Buffer.concat(chunks, bytesRead), collector);
                        zipFile.readEntry();
                    });
                });
            });

            zipFile.readEntry();
        });
    });
}

function tarString(block, start, length) {
    const end = block.indexOf(0, start);
    const finalOffset = end >= start && end < start + length ? end : start + length;
    return block.subarray(start, finalOffset).toString('utf8').trim();
}

function tarNumber(block, start, length) {
    const field = block.subarray(start, start + length);
    if (field[0] & 0x80) {
        let value = BigInt(field[0] & 0x7f);
        for (let index = 1; index < field.length; index += 1) {
            value = (value << 8n) + BigInt(field[index]);
        }
        if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('tar-number-overflow');
        return Number(value);
    }

    const value = field.toString('ascii').replace(/\0.*$/, '').trim();
    if (!value) return 0;
    if (!/^[0-7]+$/.test(value)) throw new Error('invalid-tar-number');
    const parsed = Number.parseInt(value, 8);
    if (!Number.isSafeInteger(parsed)) throw new Error('tar-number-overflow');
    return parsed;
}

function hasValidTarChecksum(block) {
    const expected = tarNumber(block, 148, 8);
    let sum = 0;
    for (let index = 0; index < block.length; index += 1) {
        sum += index >= 148 && index < 156 ? 0x20 : block[index];
    }
    return expected === sum;
}

function parsePax(data) {
    const values = {};
    let offset = 0;
    while (offset < data.length) {
        const space = data.indexOf(0x20, offset);
        if (space < 0) throw new Error('invalid-pax-record');
        const lengthText = data.subarray(offset, space).toString('ascii');
        if (!/^[1-9][0-9]*$/.test(lengthText)) throw new Error('invalid-pax-record');
        const recordLength = Number.parseInt(lengthText, 10);
        const recordEnd = offset + recordLength;
        if (!Number.isSafeInteger(recordLength) || recordEnd > data.length || recordEnd <= space + 1) {
            throw new Error('invalid-pax-record');
        }
        const record = data.subarray(space + 1, recordEnd - 1).toString('utf8');
        const equals = record.indexOf('=');
        if (equals > 0) values[record.slice(0, equals)] = record.slice(equals + 1);
        offset = recordEnd;
    }
    return values;
}

function scanTgz(filePath, archive, collector) {
    const compressed = fs.readFileSync(filePath);
    if (compressed.length > MAX_ARCHIVE_BYTES) throw new Error('invalid-archive-size');

    let tar;
    try {
        tar = zlib.gunzipSync(compressed, { maxOutputLength: MAX_UNCOMPRESSED_BYTES });
    } catch {
        throw new Error('invalid-tgz');
    }
    if (tar.length > MAX_UNCOMPRESSED_BYTES) throw new Error('invalid-tgz');

    let offset = 0;
    let nextLongName;
    let nextPax = {};
    let globalPax = {};
    while (offset + 512 <= tar.length) {
        const header = tar.subarray(offset, offset + 512);
        offset += 512;
        if (header.every(byte => byte === 0)) break;
        if (!hasValidTarChecksum(header)) throw new Error('invalid-tar-checksum');

        const size = tarNumber(header, 124, 12);
        const paddedSize = Math.ceil(size / 512) * 512;
        if (!Number.isSafeInteger(paddedSize) || offset + paddedSize > tar.length) {
            throw new Error('invalid-tar-entry-size');
        }
        const contents = tar.subarray(offset, offset + size);
        offset += paddedSize;

        const type = String.fromCharCode(header[156] || 0);
        const rawName = tarString(header, 0, 100);
        const prefix = tarString(header, 345, 155);
        const headerName = prefix ? `${prefix}/${rawName}` : rawName;

        if (type === 'L') {
            nextLongName = contents.toString('utf8').replace(/\0.*$/, '').trim();
            continue;
        }
        if (type === 'x') {
            nextPax = parsePax(contents);
            continue;
        }
        if (type === 'g') {
            globalPax = { ...globalPax, ...parsePax(contents) };
            continue;
        }

        const metadata = { ...globalPax, ...nextPax };
        const entryName = normalizeEntryName(metadata.path || nextLongName || headerName);
        nextLongName = undefined;
        nextPax = {};

        inspectEntryPath(archive, entryName, collector);
        if (type === '\0' || type === '0' || type === '7') {
            inspectText(archive, entryName, contents, collector);
        }
    }
}

async function main() {
    const [vsixPath, tgzPath, ...extra] = process.argv.slice(2);
    if (!vsixPath || !tgzPath || extra.length > 0) {
        usage();
        return;
    }

    const vsixArchive = path.basename(vsixPath);
    const tgzArchive = path.basename(tgzPath);
    const collector = createFindingCollector();

    try {
        validateArchiveFile(vsixPath, '.vsix');
        validateArchiveFile(tgzPath, '.tgz');
        await scanVsix(vsixPath, vsixArchive, collector);
        scanTgz(tgzPath, tgzArchive, collector);
    } catch {
        console.error('Archive privacy scan could not safely parse the supplied artifacts.');
        process.exitCode = 2;
        return;
    }

    const findings = collector.all();
    if (findings.length > 0) {
        for (const finding of findings) {
            console.error(JSON.stringify({
                archive: redactEntryName(finding.archive),
                entry: redactEntryName(finding.entry),
                category: finding.category,
            }));
        }
        process.exitCode = 1;
        return;
    }

    console.log(`Archive privacy regression checks passed for ${vsixArchive} and ${tgzArchive}.`);
}

module.exports = {
    createFindingCollector,
    inspectEntryPath,
    inspectText,
    shouldInspectEntryContent,
};

if (require.main === module) main();
