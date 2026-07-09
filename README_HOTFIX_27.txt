Spoons Hotfix 27 — Spectators follow dealer only

Purpose:
- Fix spectator view after Hotfix 26 so eliminated/spectator players no longer see every player's flips/selections.
- Spectators now follow only the live dealer's hand/new-card actions.
- If the dealer is no longer an active hand owner, spectators fall back to the next active dealer/first active player.
- The next round still rotates/reselects the dealer normally, and spectators follow that new dealer.

Server changes:
- server/src/SpoonsRoom.ts
- server/dist/SpoonsRoom.js

Client changes:
- No client gameplay logic changes in this hotfix.
- Itch zip is still provided so the upload set remains consistent with the hotfix version.

Deployment:
1. Apply this hotfix to C:\Projects\Spoons.
2. Push to GitHub.
3. Let Render redeploy the server.
4. Upload the matching itch.io client zip if you want the version labels to stay aligned.
