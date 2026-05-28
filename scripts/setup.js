/**
 * Setup script - run once after cloning
 * node scripts/setup.js
 */
const { execSync } = require("child_process");
const path = require("path");
const fs   = require("fs");

const laravelPath = process.env.LARAVEL_PATH ||
    path.join(__dirname, "..", "..", "etims-pos");

console.log("eTIMS Desktop POS Setup");
console.log("Laravel path: " + laravelPath);

if (!fs.existsSync(laravelPath)) {
    console.error("ERROR: Laravel app not found at: " + laravelPath);
    console.error("Clone etims-pos first: https://github.com/flavian-ndunda/etims-pos");
    process.exit(1);
}

const dbFile = path.join(laravelPath, "database", "database.sqlite");
if (!fs.existsSync(dbFile)) {
    fs.writeFileSync(dbFile, "");
    console.log("SQLite database created");
}

console.log("Running Laravel setup...");
const opts = { cwd: laravelPath, stdio: "inherit" };

try {
    execSync("php artisan key:generate --force", opts);
    execSync("php artisan migrate --force", opts);
    execSync("php artisan db:seed --force", opts);
    console.log("Setup complete! Run: npm start");
} catch (err) {
    console.error("Setup failed:", err.message);
}