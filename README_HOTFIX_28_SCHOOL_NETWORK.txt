SPOONS HOTFIX 28 - SCHOOL NETWORK / RENDER WAKE CONNECTION UPDATE
=================================================================

Render server used by the hosted client:
  https://spoons-67eu.onrender.com

INVESTIGATION
-------------
Unlike some earlier classroom games, this Spoons client did not call /health
before connecting. It attempted Colyseus room creation/joining immediately.
That meant there was no controlled 60-100 second wake process for a sleeping
free Render server and the Start Scene only showed a short generic message.

The fact that the game works in InPrivate/Incognito but can fail in a normal
browser window strongly indicates a normal-profile browser extension, cached
site rule, or managed school security policy affecting background requests or
secure WebSocket traffic.

CHANGES
-------
- Added GET /api/status as a neutral classroom wake/status endpoint.
- Kept /health for Render monitoring and older builds.
- Updated GET / to return the same JSON ready response.
- Added automatic server wake checks for up to 70 seconds.
- Reserved the remainder of a 100-second connection window for Colyseus.
- Background status checks are best-effort and are not mandatory.
- If background checks appear to be blocked immediately, the game attempts the
  real secure WebSocket without making the teacher wait unnecessarily.
- Room creation is attempted once to avoid duplicate host rooms.
- Initial room synchronisation can wait up to 20 seconds.
- Added a progress bar, elapsed time, and classroom-friendly Start Scene text.
- Disabled name/code inputs and Host/Join buttons during connection.
- Improved room-code, capacity, duplicate-device, and school-filter errors.
- Added IT guidance for spoons-67eu.onrender.com and secure WebSockets (wss).

DEPLOYMENT
----------
1. Extract this complete hotfix over the existing Spoons project.
2. Commit and push the changes to the Git repository used by Render.
3. Wait for Render to redeploy.
4. Upload spoons-hotfix-28-itchio.zip to itch.io.

Suggested commands:
  cd C:\Projects\spoons
  git add .
  git commit -m "Improve school network and Render wake handling"
  git push

No new environment variables are required.
