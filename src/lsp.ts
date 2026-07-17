import axios from "axios";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import {
	CloseAction,
	ErrorAction,
	LanguageClient,
	type LanguageClientOptions,
	type ServerOptions,
	TransportKind,
} from "vscode-languageclient/node";
import { Logger } from ".";
import { setLSPActive } from "./lspState";

const LSP_OUTPUT_CHANNEL_NAME = "NationVSC: ForgeLSP";
const LSP_GITHUB_REPO = "zack-911/forgelsp";
const LSP_RELEASE_TAG = "master";
const LSP_CUSTOM_BINARY_KEY = "nationvsc.lsp.customBinaryPath";
const LSP_GLOBAL_STORAGE_DIR = "forgelsp";

interface GitHubAsset {
	name: string;
	updated_at: string;
	browser_download_url: string;
}

interface GitHubRelease {
	tag_name: string;
	assets: GitHubAsset[];
}

interface BinaryMetadata {
	updated_at: string;
	tag_name: string;
}

interface HighlightRange {
	range: {
		start: { line: number; character: number };
		end: { line: number; character: number };
	};
	color: string;
}

interface HighlightParams {
	uri: string;
	highlights: HighlightRange[];
}

let client: LanguageClient | undefined;
let outputChannel: vscode.OutputChannel | undefined;
let depthStatusBarItem: vscode.StatusBarItem | undefined;
const decorationCache = new Map<string, vscode.TextEditorDecorationType>();
const highlightsCache = new Map<string, HighlightParams>();

function getOutputChannel() {
	if (!outputChannel) {
		outputChannel = vscode.window.createOutputChannel(LSP_OUTPUT_CHANNEL_NAME);
	}
	return outputChannel;
}

function log(message: string) {
	getOutputChannel().appendLine(message);
	Logger?.info(`[ForgeLSP] ${message}`);
}

function getPlatformBinaryName(): string | null {
	const platform = os.platform();
	const arch = os.arch();

	if (platform === "linux") {
		if (arch === "x64") return "forgevsc-linux-x86_64";
		if (arch === "arm64") return "forgevsc-linux-aarch64";
	} else if (platform === "darwin") {
		if (arch === "x64") return "forgevsc-macos-x86_64";
		if (arch === "arm64") return "forgevsc-macos-aarch64";
	} else if (platform === "win32") {
		if (arch === "x64") return "forgevsc-windows-x86_64.exe";
	}

	return null;
}

function getLspStoragePath(context: vscode.ExtensionContext): string {
	return path.join(context.globalStorageUri.fsPath, LSP_GLOBAL_STORAGE_DIR);
}

function getMetadataPath(binaryPath: string): string {
	return `${binaryPath}.meta.json`;
}

function readMetadata(binaryPath: string): BinaryMetadata | null {
	const metadataPath = getMetadataPath(binaryPath);
	if (!fs.existsSync(metadataPath)) return null;

	try {
		return JSON.parse(fs.readFileSync(metadataPath, "utf-8")) as BinaryMetadata;
	} catch {
		return null;
	}
}

function writeMetadata(binaryPath: string, metadata: BinaryMetadata) {
	try {
		fs.writeFileSync(getMetadataPath(binaryPath), JSON.stringify(metadata, null, 2));
	} catch (e) {
		log(`Failed to write metadata: ${e}`);
	}
}

async function getLatestReleaseInfo(
	binaryName: string,
): Promise<{ updated_at: string; tag_name: string } | null> {
	try {
		const response = await axios.get<GitHubRelease>(
			`https://api.github.com/repos/${LSP_GITHUB_REPO}/releases/tags/${LSP_RELEASE_TAG}`,
		);
		const asset = response.data.assets.find((a) => a.name === binaryName);
		if (!asset) return null;
		return { updated_at: asset.updated_at, tag_name: response.data.tag_name };
	} catch (e) {
		log(`Failed to check for updates: ${e}`);
		return null;
	}
}

async function shouldUpdate(binaryPath: string, binaryName: string): Promise<boolean> {
	const localMetadata = readMetadata(binaryPath);
	if (!localMetadata) return false;

	const remoteInfo = await getLatestReleaseInfo(binaryName);
	if (!remoteInfo) return false;

	return new Date(remoteInfo.updated_at) > new Date(localMetadata.updated_at);
}

async function downloadBinary(filename: string, destPath: string): Promise<void> {
	const url = `https://github.com/${LSP_GITHUB_REPO}/releases/download/${LSP_RELEASE_TAG}/${filename}`;
	log(`Downloading binary from ${url}`);

	return vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: vscode.l10n.t("Downloading {0}...", filename),
			cancellable: false,
		},
		async () => {
			const response = await axios({
				method: "get",
				url,
				responseType: "stream",
			});

			const writer = fs.createWriteStream(destPath);

			await new Promise<void>((resolve, reject) => {
				response.data.pipe(writer);
				let error: Error | null = null;

				writer.on("error", (err) => {
					error = err;
					writer.close();
					reject(err);
				});

				writer.on("close", async () => {
					if (error) return;
					log("Download complete.");
					const releaseInfo = await getLatestReleaseInfo(filename);
					if (releaseInfo) writeMetadata(destPath, releaseInfo);
					resolve();
				});
			});
		},
	);
}

function getServerBinaryPath(context: vscode.ExtensionContext): {
	binaryName: string | null;
	serverPath: string;
} {
	const binaryName = getPlatformBinaryName();
	const storagePath = getLspStoragePath(context);
	const customPath = context.globalState.get<string>(LSP_CUSTOM_BINARY_KEY);

	if (customPath && fs.existsSync(customPath)) {
		return { binaryName, serverPath: customPath };
	}

	return { binaryName, serverPath: binaryName ? path.join(storagePath, binaryName) : "" };
}

function ensureStoragePath(context: vscode.ExtensionContext): string {
	const storagePath = getLspStoragePath(context);
	if (!fs.existsSync(storagePath)) {
		fs.mkdirSync(storagePath, { recursive: true });
	}
	return storagePath;
}

async function prepareBinary(context: vscode.ExtensionContext): Promise<string | null> {
	const { binaryName, serverPath } = getServerBinaryPath(context);
	if (!binaryName) {
		void vscode.window.showErrorMessage(
			vscode.l10n.t("ForgeLSP: Unsupported platform or architecture."),
		);
		return null;
	}

	ensureStoragePath(context);

	if (!fs.existsSync(serverPath)) {
		const choice = await vscode.window.showInformationMessage(
			vscode.l10n.t("ForgeLSP binary not found. Download {0}?", binaryName),
			vscode.l10n.t("Download"),
			vscode.l10n.t("Cancel"),
		);
		if (choice !== vscode.l10n.t("Download")) return null;

		try {
			await downloadBinary(binaryName, serverPath);
			void vscode.window.showInformationMessage(
				vscode.l10n.t("ForgeLSP binary downloaded successfully."),
			);
		} catch (e) {
			const msg = vscode.l10n.t("ForgeLSP: Failed to download binary. {0}", String(e));
			void vscode.window.showErrorMessage(msg);
			log(msg);
			return null;
		}
	} else if (await shouldUpdate(serverPath, binaryName)) {
		const choice = await vscode.window.showInformationMessage(
			vscode.l10n.t("A new version of ForgeLSP is available. Update now?"),
			vscode.l10n.t("Update"),
			vscode.l10n.t("Skip"),
		);
		if (choice === vscode.l10n.t("Update")) {
			try {
				log("Updating ForgeLSP binary...");
				await downloadBinary(binaryName, serverPath);
				void vscode.window.showInformationMessage(
					vscode.l10n.t("ForgeLSP binary updated successfully."),
				);
			} catch (e) {
				const msg = vscode.l10n.t("ForgeLSP: Failed to update binary. {0}", String(e));
				void vscode.window.showErrorMessage(msg);
				log(msg);
			}
		}
	}

	if (os.platform() !== "win32") {
		try {
			fs.chmodSync(serverPath, "755");
		} catch {
			// Ignore permission errors; binary may already be executable.
		}
	}

	return serverPath;
}

function getDecoration(color: string) {
	let deco = decorationCache.get(color);
	if (!deco) {
		deco = vscode.window.createTextEditorDecorationType({ color });
		decorationCache.set(color, deco);
	}
	return deco;
}

function clearHighlights(editor: vscode.TextEditor) {
	for (const deco of decorationCache.values()) {
		editor.setDecorations(deco, []);
	}
}

function applyHighlights(params: HighlightParams) {
	highlightsCache.set(params.uri, params);

	const editor = vscode.window.visibleTextEditors.find(
		(e) => e.document.uri.toString() === params.uri,
	);
	if (!editor) return;

	const grouped = new Map<string, vscode.Range[]>();
	for (const h of params.highlights) {
		const range = new vscode.Range(
			h.range.start.line,
			h.range.start.character,
			h.range.end.line,
			h.range.end.character,
		);
		const existing = grouped.get(h.color) ?? [];
		existing.push(range);
		grouped.set(h.color, existing);
	}

	clearHighlights(editor);
	for (const [color, ranges] of grouped) {
		editor.setDecorations(getDecoration(color), ranges);
	}
}

function updateDepth(depth: number) {
	if (!depthStatusBarItem) {
		depthStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
		depthStatusBarItem.show();
	}
	depthStatusBarItem.text = vscode.l10n.t("Depth: {0}", depth);
}

export async function startLSP(context: vscode.ExtensionContext): Promise<void> {
	const config = vscode.workspace.getConfiguration("nationvsc.lsp");
	if (config.get<boolean>("enabled") === false) {
		log("ForgeLSP is disabled by user setting.");
		return;
	}

	if (vscode.env.uiKind === vscode.UIKind.Web) {
		log("ForgeLSP is not supported in web environments.");
		return;
	}

	if (client?.isRunning()) return;

	log("ForgeLSP extension activating...");

	ensureForgeLSPConfig();

	const serverPath = await prepareBinary(context);
	if (!serverPath) return;

	const serverOptions: ServerOptions = {
		run: { command: serverPath, transport: TransportKind.stdio },
		debug: { command: serverPath, transport: TransportKind.stdio },
	};

	const trace = config.get<string>("trace.server", "off");
	const clientOptions: LanguageClientOptions = {
		documentSelector: [
			{ scheme: "file", language: "javascript" },
			{ scheme: "file", language: "typescript" },
			{ scheme: "file", language: "javascriptreact" },
			{ scheme: "file", language: "typescriptreact" },
			{ scheme: "file", language: "forge" },
		],
		errorHandler: {
			error: (error, message) => {
				log(`LSP Error: ${error} ${message}`);
				return { action: ErrorAction.Continue };
			},
			closed: () => {
				log("LSP Connection Closed.");
				return { action: CloseAction.Restart };
			},
		},
		outputChannel: getOutputChannel(),
		traceOutputChannel: trace === "off" ? undefined : getOutputChannel(),
	};

	client = new LanguageClient(
		"nationvsc.forgeLSP",
		"Forge Language Server",
		serverOptions,
		clientOptions,
	);

	client.onNotification("forge/highlights", (params: HighlightParams) => {
		applyHighlights(params);
	});

	client.onNotification("forge/updateDepth", (params: { depth: number }) => {
		updateDepth(params.depth);
	});

	log("Starting Forge Language Server...");
	await client.start();
	setLSPActive(true);
	log("Forge Language Server started.");
}

export async function stopLSP(): Promise<void> {
	setLSPActive(false);
	if (client) {
		await client.stop();
		client = undefined;
	}
}

export async function restartLSP(context: vscode.ExtensionContext): Promise<void> {
	await stopLSP();
	await startLSP(context);
}

export function registerLSPCommands(context: vscode.ExtensionContext) {
	context.subscriptions.push(
		vscode.commands.registerCommand("nationvsc.createForgeConfig", async () => {
			const folders = vscode.workspace.workspaceFolders;
			if (!folders?.length) {
				void vscode.window.showErrorMessage(vscode.l10n.t("ForgeLSP: No workspace open."));
				return;
			}

			const rootPath = folders[0].uri.fsPath;
			const configPath = path.join(rootPath, "forgeconfig.json");

			if (fs.existsSync(configPath)) {
				void vscode.window.showInformationMessage(
					vscode.l10n.t("ForgeLSP: forgeconfig.json already exists."),
				);
				return;
			}

			const defaultConfig = {
				urls: ["github:tryforge/forgescript"],
				log_level: "info",
			};

			fs.writeFileSync(configPath, `${JSON.stringify(defaultConfig, null, 2)}\n`);
			void vscode.window.showInformationMessage(
				vscode.l10n.t(
					"ForgeLSP: forgeconfig.json created. Please reload the window to activate fully.",
				),
			);
			await startLSP(context);
		}),

		vscode.commands.registerCommand("nationvsc.updateForgeLSP", async () => {
			const { binaryName, serverPath } = getServerBinaryPath(context);
			if (!binaryName || !serverPath) {
				void vscode.window.showErrorMessage(
					vscode.l10n.t("ForgeLSP: Unsupported platform or architecture."),
				);
				return;
			}

			ensureStoragePath(context);
			await stopLSP();

			const customPath = context.globalState.get<string>(LSP_CUSTOM_BINARY_KEY);
			if (customPath && fs.existsSync(customPath)) {
				void vscode.window.showInformationMessage(
					vscode.l10n.t("ForgeLSP: Using custom binary; update skipped."),
				);
			} else {
				try {
					await downloadBinary(binaryName, serverPath);
					if (os.platform() !== "win32") fs.chmodSync(serverPath, "755");
					void vscode.window.showInformationMessage(
						vscode.l10n.t("ForgeLSP binary updated successfully. Restarting LSP..."),
					);
				} catch (e) {
					const msg = vscode.l10n.t("ForgeLSP: Failed to update binary. {0}", String(e));
					void vscode.window.showErrorMessage(msg);
					log(msg);
				}
			}

			await startLSP(context);
		}),

		vscode.commands.registerCommand("nationvsc.useCustomForgeLSPBinary", async () => {
			const fileUri = await vscode.window.showOpenDialog({
				canSelectMany: false,
				openLabel: vscode.l10n.t("Select LSP Binary"),
				filters: { Executables: ["*"] },
			});
			if (!fileUri?.length) {
				void vscode.window.showInformationMessage(vscode.l10n.t("ForgeLSP: No binary selected."));
				return;
			}

			const selectedPath = fileUri[0].fsPath;
			await context.globalState.update(LSP_CUSTOM_BINARY_KEY, selectedPath);
			void vscode.window.showInformationMessage(
				vscode.l10n.t("ForgeLSP: Custom binary set to {0}", selectedPath),
			);
			await restartLSP(context);
		}),

		vscode.commands.registerCommand("nationvsc.resetForgeLSPPath", async () => {
			await context.globalState.update(LSP_CUSTOM_BINARY_KEY, undefined);
			void vscode.window.showInformationMessage(
				vscode.l10n.t("ForgeLSP: Reset to default binary path."),
			);
			await restartLSP(context);
		}),

		vscode.commands.registerCommand("nationvsc.restartForgeLSP", async () => {
			await restartLSP(context);
		}),

		vscode.window.onDidChangeActiveTextEditor((editor) => {
			if (editor) {
				const cached = highlightsCache.get(editor.document.uri.toString());
				if (cached) applyHighlights(cached);
			}
		}),

		vscode.workspace.createFileSystemWatcher("**/forgeconfig.json").onDidChange(() => {
			if (client?.isRunning()) client.restart();
		}),
	);
}

export function hasForgeLSPConfig(): boolean {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders?.length) return false;

	const rootPath = folders[0].uri.fsPath;
	return (
		fs.existsSync(path.join(rootPath, "forgeconfig.json")) ||
		fs.existsSync(path.join(rootPath, ".vscode", "forgeconfig.json")) ||
		hasForgeVSCConfigWithCustomFunctions(rootPath)
	);
}

function hasForgeVSCConfigWithCustomFunctions(rootPath: string): boolean {
	for (const candidate of [
		path.join(rootPath, ".forgevsc.json"),
		path.join(rootPath, ".vscode", ".forgevsc.json"),
	]) {
		if (!fs.existsSync(candidate)) continue;
		try {
			const data = JSON.parse(fs.readFileSync(candidate, "utf-8")) as {
				customFunctionPaths?: string | string[];
			};
			if (
				data.customFunctionPaths &&
				(Array.isArray(data.customFunctionPaths)
					? data.customFunctionPaths.length > 0
					: typeof data.customFunctionPaths === "string")
			) {
				return true;
			}
		} catch {
			//
		}
	}
	return false;
}

function readForgeVSCConfig(rootPath: string): {
	customFunctionPaths?: string[];
} | null {
	for (const candidate of [
		path.join(rootPath, ".forgevsc.json"),
		path.join(rootPath, ".vscode", ".forgevsc.json"),
	]) {
		if (!fs.existsSync(candidate)) continue;
		try {
			const data = JSON.parse(fs.readFileSync(candidate, "utf-8")) as {
				customFunctionPaths?: string | string[];
			};
			const paths = Array.isArray(data.customFunctionPaths)
				? data.customFunctionPaths
				: typeof data.customFunctionPaths === "string"
					? [data.customFunctionPaths]
					: [];
			return { customFunctionPaths: paths.length > 0 ? paths : undefined };
		} catch {
			//
		}
	}
	return null;
}

function ensureForgeLSPConfig(): void {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders?.length) return;

	const rootPath = folders[0].uri.fsPath;

	if (
		fs.existsSync(path.join(rootPath, "forgeconfig.json")) ||
		fs.existsSync(path.join(rootPath, ".vscode", "forgeconfig.json"))
	) {
		return;
	}

	const forgeVSCConfig = readForgeVSCConfig(rootPath);
	if (!forgeVSCConfig?.customFunctionPaths?.length) return;

	const relPath = forgeVSCConfig.customFunctionPaths[0];
	const forgeConfig = {
		urls: ["github:tryforge/forgescript"],
		custom_functions_path: relPath,
		log_level: "info",
	};

	const destPath = path.join(rootPath, "forgeconfig.json");
	fs.writeFileSync(destPath, `${JSON.stringify(forgeConfig, null, 2)}\n`);
	log(`Generated forgeconfig.json from .forgevsc.json custom function paths.`);
}

export function deactivateLSP(): Thenable<void> | undefined {
	return client?.stop();
}
