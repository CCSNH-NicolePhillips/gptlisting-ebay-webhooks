// /.netlify/functions/ebay-platform
// Netlify Function (CommonJS) for eBay Platform Notifications (Trading API)c
exports.handler = async function (event, context) {
  // eBay may POST XML or name/value form. We just log and 200 fast.
  console.log("Platform notification headers:", event.headers);
  console.log("Platform notification body:", event.body);
  return { statusCode: 200, body: "" };
};
