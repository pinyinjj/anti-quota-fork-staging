/**
 * 账号切换服务 - 不能杀进程，只能注入 Token + Reload Window
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Account } from '../types/account';
import * as oauthService from './oauthService';

export class DirectSwitchService {
    private outputChannel: vscode.OutputChannel;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('Anti Quota - 直接切换');
    }

    private log(message: string): void {
        const timestamp = new Date().toLocaleTimeString();
        this.outputChannel.appendLine(`[${timestamp}] ${message}`);
        console.log(`[DirectSwitch] ${message}`);
    }

    async switchAccount(account: Account): Promise<{
        success: boolean;
        error?: string;
    }> {
        this.outputChannel.clear();
        this.outputChannel.show();

        try {
            this.log('========== 开始账号切换 (独立进程模式) ==========');
            this.log(`目标账号: ${account.email}`);

            // 1. 切号前强制刷新 Token。
            // Google 可能在本地 expiry 到期前撤销 access_token；仅检查时间会把
            // 已失效的 Token 写进 agy Keyring，随后 userinfo/loadCodeAssist 全部 401。
            const now = Math.floor(Date.now() / 1000);
            this.log('正在刷新目标账号 Token...');
            try {
                const tokenRes = await oauthService.refreshAccessToken(account.token.refresh_token);
                account.token.access_token = tokenRes.access_token;
                account.token.expires_in = tokenRes.expires_in;
                account.token.expiry_timestamp = now + tokenRes.expires_in;
                this.log('✓ Token 刷新成功');
            } catch (error) {
                throw new Error(`目标账号登录凭据已失效，无法切换。请删除后重新添加该账号。详细信息: ${error}`);
            }


            // 2. 获取当前会话ID
            const chatSessionService = await import('./chatSessionService');
            const activeSessionId = chatSessionService.getCurrentSessionIdFromDb();
            this.log(`当前活跃会话 ID: ${activeSessionId || '未找到'}`);

            // 2.1 标记切号
            const antigravityService = await import('./antigravityService');
            antigravityService.markSwitchPending(undefined, account.email, activeSessionId || undefined);
            this.log('✓ 切号标记已设置');

            // 新版 agy CLI 使用 ~/.gemini/antigravity-cli/antigravity-oauth-token，
            // 不存在旧桌面版 state.vscdb。直接更新 CLI 配置，避免后台脚本报“数据库不存在”。
            if (!fs.existsSync(antigravityService.getDbPath()) && antigravityService.isAgyCliAvailable()) {
                await antigravityService.writeAgyCliAuth(
                    account.token.access_token,
                    account.token.refresh_token,
                    account.token.expiry_timestamp
                );
                antigravityService.clearSwitchPending();
                this.log('✓ agy CLI 文件和 Windows Keyring 均已更新');
                this.log('请退出当前 agy 会话后重新运行 agy，使新账号生效');
                vscode.window.showInformationMessage(
                    `✅ agy CLI 已切换到 ${account.email}。请退出当前 agy 会话并重新运行 agy。`
                );
                return { success: true };
            }

            // 3. 准备脚本路径
            const scriptPath = path.join(__dirname, '../../scripts/switch_account.js');
            if (!fs.existsSync(scriptPath)) {
                throw new Error(`找不到切换脚本: ${scriptPath}`);
            }

            // 4. 启动独立进程
            this.log('正在启动独立切换进程...');
            this.log(`Script: ${scriptPath}`);

            const child = require('child_process').spawn('node', [
                scriptPath,
                account.token.access_token,
                account.token.refresh_token,
                Math.floor(account.token.expiry_timestamp).toString(),
                account.email
            ], {
                detached: true,
                stdio: 'ignore'
            });

            if (child.disconnect) child.disconnect();
            child.unref();

            this.log('✓ 独立进程已启动 (PID: ' + child.pid + ')');
            this.log('插件任务完成，Antigravity 将在 3 秒后自动重启...');

            vscode.window.showInformationMessage(`✅ 切换任务已移交后台 (PID: ${child.pid})。\n\nAntigravity 即将自动重启，在此期间请勿手动操作。`);

            return { success: true };

        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.log(`❌ 启动失败: ${msg}`);
            vscode.window.showErrorMessage(`切换失败: ${msg}`);
            return { success: false, error: msg };
        }
    }
}
