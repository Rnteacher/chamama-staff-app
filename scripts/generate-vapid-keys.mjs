// Prints a new VAPID key pair for Web Push.
// Usage: npm run gen:vapid
// Put the values in .env.local (never commit real keys).
import webpush from "web-push";

const keys = webpush.generateVAPIDKeys();
console.log("NEXT_PUBLIC_VAPID_PUBLIC_KEY=" + keys.publicKey);
console.log("VAPID_PRIVATE_KEY=" + keys.privateKey);
