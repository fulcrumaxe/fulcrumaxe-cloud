const p = new URLSearchParams(self.location.search).get("p");
fetch("http://127.0.0.1:" + p + "/shared-fetch").catch(() => {});
try { importScripts("http://127.0.0.1:" + p + "/shared-import"); } catch (e) {}
