// __mocks__/node-fetch.js
// Redirect node-fetch to Node.js 18+ native fetch for the Jest test environment.
// This avoids the "Cannot use import statement outside a module" error that
// occurs when Jest (running in CJS mode) tries to transform node-fetch v3
// (a pure-ESM package). Uses CommonJS exports so Jest can require() this file.
module.exports = globalThis.fetch;
module.exports.default = globalThis.fetch;
module.exports.Headers = globalThis.Headers;
module.exports.Request = globalThis.Request;
module.exports.Response = globalThis.Response;
