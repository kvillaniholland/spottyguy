# SpottyGuy

SpottyGuy is a tool for managing your Spotify library in ways that are almost certainly only useful to me.

## Features

-   Unplaylisted: Tracks all your "Liked" songs that you have not put in a playlist yet, and keeps them in a playlist called "Unplaylisted".
-   "Eyes" playlist: Throw stuff you've been meaning to check out in a playlist called "👀", and they will be automatically removed when you "Like" them, or add them to a playlist.
-   Decades: Creates playlists for the past 6 years, and then each decade before that and sorts your music into those playlists. (These don't count towards "Unplaylisted")

## How to use

1. Run `yarn install`
2. Create a file called `.env` in the root directory of this repository and fill it out like so:
   ```
   API_ID=[Your Spotify developer client ID]
   API_SECRET=[Your Spotify developer client secret]
   USER_ID=[Your Spotify user ID]
   ```
3. Run `yarn start -h` to see command line options.
4. Run `yarn start` with the options you want, ex. `yarn start -uye` will update Unplaylisted, Eyes, and Decades.

## Why

I dunno, I am a little OCD about my music collection. This was a fun project.
