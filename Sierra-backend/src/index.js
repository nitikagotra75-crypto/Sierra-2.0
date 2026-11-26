require("dotenv").config();
const { connectDB } = require("./db");
const { createApp } = require("./app");

async function main(){
    const dbInfo = await connectDB();
    global.__SIERRA_MEMDB_URI__ = dbInfo.ephemeral ? dbInfo.uri : null;

    const app = createApp();

    const PORT = process.env.PORT || 5001;
    app.listen(PORT , () => {
        console.log(`[Sierra] server listening on port ${PORT}`);
    });
}

main().catch((err) => {
    console.error("[Sierra] failed to start: " + (err && err.message ? err.message : err));
    process.exit(1);
});
