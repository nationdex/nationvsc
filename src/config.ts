import * as vscode from "vscode";
import { toArray } from ".";

export interface IExtensionConfig {
	enabledWorkspaces?: string[];
	customFunctionPaths?: string | string[];
	additionalPackages?: string[];
	colors?: {
		function?: {
			name?: string;
			dollar?: string;
			semicolon?: string;
		};
		arguments?: {
			condition?: string;
		};
		operators?: {
			negation?: string;
			silent?: string;
			count?: string;
			countDelimiter?: string;
		};
	};
	features?: {
		folding?: boolean;
		hoverInfo?: boolean;
		suggestions?: boolean;
		signatureHelp?: boolean;
		diagnostics?: boolean;
		autocompletion?: boolean;
	};
	rpc?: {
		enabled?: boolean;
	};
}

export const Defaults: Required<IExtensionConfig> = {
	enabledWorkspaces: [],
	customFunctionPaths: [],
	additionalPackages: [],
	colors: {
		function: {
			name: "#AC75FF",
			dollar: "#FE7CEB",
			semicolon: "#C586C0",
		},
		arguments: {
			condition: "#4FC1FF",
		},
		operators: {
			negation: "#4FA3FF",
			silent: "#FF9F43",
			count: "#33D17A",
			countDelimiter: "#76E3A0",
		},
	},
	features: {
		folding: true,
		hoverInfo: true,
		suggestions: true,
		signatureHelp: true,
		diagnostics: true,
		autocompletion: true,
	},
	rpc: {
		enabled: true,
	},
};

let cached: Required<IExtensionConfig> = Defaults;

/**
 * Returns the settings config of the extension.
 * @returns
 */
export function getSettingsConfig() {
	const vs = vscode.workspace.getConfiguration("nationvsc");
	const workspaceSection = vs.get<Record<string, unknown>>("workspace") ?? {};
	const globalSection = vs.get<Record<string, unknown>>("global") ?? {};

	const getWorkspaceString = (key: string) =>
		typeof workspaceSection[key] === "string" ? (workspaceSection[key] as string) : undefined;
	const getWorkspaceStringArray = (key: string) =>
		Array.isArray(workspaceSection[key]) ? (workspaceSection[key] as string[]) : undefined;
	const getWorkspaceBoolean = (key: string) =>
		typeof workspaceSection[key] === "boolean" ? (workspaceSection[key] as boolean) : undefined;
	const getGlobalStringArray = (key: string) =>
		Array.isArray(globalSection[key]) ? (globalSection[key] as string[]) : undefined;

	return {
		global: {
			enabledWorkspaces: getGlobalStringArray("enabledWorkspaces"),
		},
		workspace: {
			customFunctionPaths: getWorkspaceStringArray("customFunctionPaths"),
			additionalPackages: getWorkspaceStringArray("additionalPackages"),
			colors: {
				function: {
					name: getWorkspaceString("colors.function.name"),
					dollar: getWorkspaceString("colors.function.dollar"),
					semicolon: getWorkspaceString("colors.function.semicolon"),
				},
				arguments: {
					condition: getWorkspaceString("colors.arguments.condition"),
				},
				operators: {
					negation: getWorkspaceString("colors.operators.negation"),
					silent: getWorkspaceString("colors.operators.silent"),
					count: getWorkspaceString("colors.operators.count"),
					countDelimiter: getWorkspaceString("colors.operators.countDelimiter"),
				},
			},
			features: {
				folding: getWorkspaceBoolean("features.folding"),
				hoverInfo: getWorkspaceBoolean("features.hoverInfo"),
				suggestions: getWorkspaceBoolean("features.suggestions"),
				signatureHelp: getWorkspaceBoolean("features.signatureHelp"),
				diagnostics: getWorkspaceBoolean("features.diagnostics"),
				autocompletion: getWorkspaceBoolean("features.autocompletion"),
			},
			rpc: {
				enabled: getWorkspaceBoolean("rpc.enabled"),
			},
		},
	};
}

/**
 * Returns the config options of the extension.
 * @returns
 */
export function getExtensionConfig() {
	return cached;
}

/**
 * Finds the config file path of the extension.
 * @param root The root directory.
 * @returns
 */
export async function findExtensionConfig(root: vscode.Uri) {
	const paths = [
		vscode.Uri.joinPath(root, ".forgevsc.json"),
		vscode.Uri.joinPath(root, ".vscode", ".forgevsc.json"),
	];

	for (const uri of paths) {
		try {
			await vscode.workspace.fs.stat(uri);
			return uri;
		} catch {}
	}

	return null;
}

/**
 * Loads the config options of the extension.
 * @returns
 */
export async function loadExtensionConfig() {
	const folders = vscode.workspace.workspaceFolders;
	const vs = getSettingsConfig();
	let file: IExtensionConfig = {};

	if (folders?.length) {
		const root = folders[0].uri;
		const uri = await findExtensionConfig(root);

		if (uri) {
			try {
				const raw = await vscode.workspace.fs.readFile(uri);
				const text = new TextDecoder().decode(raw);
				file = JSON.parse(text);
			} catch {}
		}
	}

	cached = {
		enabledWorkspaces: vs.global.enabledWorkspaces ?? [],
		customFunctionPaths: toArray(
			file.customFunctionPaths ?? vs.workspace.customFunctionPaths ?? Defaults.customFunctionPaths,
		),
		additionalPackages: Array.from(
			new Set([
				...Defaults.additionalPackages,
				...(vs.workspace.additionalPackages ?? []),
				...(file.additionalPackages ?? []),
			]),
		),
		colors: {
			function: {
				...Defaults.colors.function,
				...(vs.workspace.colors?.function ?? {}),
				...(file.colors?.function ?? {}),
			},
			arguments: {
				...Defaults.colors.arguments,
				...(vs.workspace.colors?.arguments ?? {}),
				...(file.colors?.arguments ?? {}),
			},
			operators: {
				...Defaults.colors.operators,
				...(vs.workspace.colors?.operators ?? {}),
				...(file.colors?.operators ?? {}),
			},
		},
		features: {
			folding:
				file.features?.folding ?? vs.workspace.features?.folding ?? Defaults.features.folding,
			hoverInfo:
				file.features?.hoverInfo ?? vs.workspace.features?.hoverInfo ?? Defaults.features.hoverInfo,
			suggestions:
				file.features?.suggestions ??
				vs.workspace.features?.suggestions ??
				Defaults.features.suggestions,
			signatureHelp:
				file.features?.signatureHelp ??
				vs.workspace.features?.signatureHelp ??
				Defaults.features.signatureHelp,
			diagnostics:
				file.features?.diagnostics ??
				vs.workspace.features?.diagnostics ??
				Defaults.features.diagnostics,
			autocompletion:
				file.features?.autocompletion ??
				vs.workspace.features?.autocompletion ??
				Defaults.features.autocompletion,
		},
		rpc: {
			enabled: vs.workspace.rpc.enabled ?? Defaults.rpc.enabled,
		},
	};

	return cached;
}
