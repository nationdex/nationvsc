import { execSync } from "child_process";
import { config } from "dotenv";

// Load environment variables from .env file
config();

const ovsxPat = process.env.OVSX_PAT;

if (!ovsxPat) {
	console.error("Error: OVSX_PAT environment variable is not set");
	console.error("Please create a .env file with: OVSX_PAT=your_token_here");
	process.exit(1);
}

console.log("Building package...");
try {
	execSync("bun run package", { stdio: "inherit" });
} catch {
	console.error("Package build failed");
	process.exit(1);
}

console.log("Publishing to Open VSX...");
try {
	execSync(`bunx ovsx publish -p "${ovsxPat}"`, { stdio: "inherit" });
	console.log("Successfully published to Open VSX!");
} catch {
	console.error("Publishing failed");
	process.exit(1);
}
