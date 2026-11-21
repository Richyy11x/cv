# Drive-Thru Wait Board

A public page where people tap in when they join a drive-thru line and tap out
when they get their food. It estimates the current wait from recent times.
Runs on Firebase's free (Spark) plan.

- `public/` – the page (`index.html`, `app.js`, `firebase-config.js`)
- `firestore.rules` – who can read and write check-ins
- `firebase.json` – hosting and rules config

## One-time Firebase setup (console, works on a phone)

1. Go to https://console.firebase.google.com and **Create a project**. Analytics can be turned off.
2. **Build → Authentication → Get started → Sign-in method → Anonymous → Enable.**
3. **Build → Firestore Database → Create database.** Pick a location near you and start in **production mode**.
4. In Firestore, open the **Rules** tab, replace everything with the contents of `firestore.rules`, and **Publish**.
5. **Project settings (gear) → Your apps → Web (`</>`)**. Register the app (no need for Hosting here) and copy the `firebaseConfig` values into `public/firebase-config.js`.

## Deploy (from a computer)

```sh
npm install -g firebase-tools
firebase login
cd drive-thru
# .firebaserc already points at the project
firebase deploy             # deploys hosting + rules
```

The site is then live at `https://<project-id>.web.app`.

## How the estimate works

- Uses the middle value (median) of up to 10 cars that checked out in the last 90 minutes.
- If nobody has checked out in 90 minutes, it falls back to all of today's timed cars.
- If a car still in line has already waited longer, the estimate rises to match.
- Check-ins left open for more than 3 hours are ignored.

## Abuse protection

- Each browser gets an anonymous Firebase ID and can only edit or delete its own check-ins.
- One check-in per browser every 5 minutes; arrivals can be back-dated at most 60 minutes.
- Waits over 3 hours are rejected.

These stop casual mistakes and junk, not a determined attacker (clearing site data creates a new ID).
