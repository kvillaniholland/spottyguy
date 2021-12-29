require("dotenv").config();

const fetch = require("node-fetch");
const fs = require("fs");
const open = require("open");

const caches = {
    _unplaylisted_tracks: false,
    _playlists: false,
    _saved_tracks: false,
    _eyes_tracks: false,
    _playlisted_tracks: false,
};

const emptyCache = (cacheName) => {
    if (!caches[cacheName]) {
        try {
            fs.unlinkSync(`./_cache/${cacheName}.json`) && (caches[cacheName] = true);
        } catch (e) {}
    } else {
        return;
    }
};

// SECRETS
const id = process.env.API_ID;
const secret = process.env.API_SECRET;
const user = process.env.USER_ID;

const scope = "playlist-modify-public playlist-modify-private playlist-read-private user-library-read";

const url = `https://accounts.spotify.com/authorize?response_type=code&client_id=${encodeURIComponent(
    id
)}&scope=${encodeURIComponent(scope)}&redirect_uri=${encodeURIComponent("http://localhost:8888/callback")}`;

// Global, gets set by the Express server in the callback eventually. Gross.
let token;

function printProgress(progress) {
    process.stdout.clearLine();
    process.stdout.cursorTo(0);
    process.stdout.write(progress + "%");
}

const authHeader = () => ({
    Authorization: `Bearer ${token}`,
});

async function getAllPaginated(url, prevBody = null, accumulatedValue = [], log = true, tries = 1) {
    if (tries > 100) {
        // return accumulatedValue;
    }
    const response = !prevBody
        ? await fetch(url, { headers: { ...authHeader() } })
        : await fetch(prevBody.next, { headers: { ...authHeader() } });
    if (response.status == 429) {
        const retry = response.headers["Retry-After"];
        await new Promise((resolve) => setTimeout(resolve, retry));
        return await getAllPaginated(prevBody?.next || url, prevBody, accumulatedValue, log, tries + 1);
    }
    try {
        const body = await response.json();
        const everything = [...accumulatedValue, ...body.items];
        if (log) printProgress(Math.round((everything.length / body.total) * 100));
        if (!body.next) {
            if (log) console.log(`\nTook ${tries} requests.`);
            return everything;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
        return await getAllPaginated(body.next, body, everything, log, tries + 1);
    } catch (e) {
        console.log("\n\nerror\n", e);
        console.log("\n\n");
        console.log("response\n", response);
        console.log("\n\n");
        console.log("body\n", { ...body, items: [] });
        console.log("\n\n");
        console.log("body type\n", typeof body.items);
        console.log("\n\n");
        throw e;
    }
}

async function getPlaylists() {
    return await getAllPaginated("https://api.spotify.com/v1/me/playlists");
}

async function getSongsForPlaylist(playlist, log = false) {
    return await getAllPaginated(`https://api.spotify.com/v1/playlists/${playlist.id}/tracks`, null, [], log);
}

async function getSavedTracks() {
    return await getAllPaginated("https://api.spotify.com/v1/me/tracks?limit=50");
}

async function createPlaylist(name = "Unplaylisted") {
    emptyCache("_playlists");
    const response = await fetch(`https://api.spotify.com/v1/users/${user}/playlists`, {
        method: "POST",
        headers: { ...authHeader() },
        body: JSON.stringify({ name }),
    });
    return await response.json();
}

async function deletePlaylist(playlist) {
    emptyCache("_playlists");
    const response = await fetch(`https://api.spotify.com/v1/playlists/${playlist.id}/followers`, {
        method: "DELETE",
        headers: { ...authHeader() },
    });
    return response;
}

async function addTracksToPlaylist(playlist, tracks) {
    return await fetch(`https://api.spotify.com/v1/playlists/${playlist.id}/tracks`, {
        method: "POST",
        headers: { ...authHeader() },
        body: JSON.stringify({
            uris: tracks.map((track) => track.track.uri),
        }),
    });
}

async function removeTracksFromPlaylist(playlist, tracks) {
    return await fetch(`https://api.spotify.com/v1/playlists/${playlist.id}/tracks`, {
        method: "DELETE",
        headers: { ...authHeader() },
        body: JSON.stringify({
            tracks: tracks.map((track) => ({
                uri: track.track.uri,
            })),
        }),
    });
}

async function getFromCacheOrLoad(cacheName, loadFunction, cacheKey = null) {
    let result;
    try {
        result = require(`./_cache/${cacheName}`);
    } catch (e) {}
    if (!result || !result.length) {
        result = await loadFunction();
        const data = JSON.stringify(result);
        fs.writeFileSync(`./_cache/${cacheName}`, data);
    }
    if (cacheKey) caches[cacheKey] = false;
    return result;
}

async function loadData() {
    // Playlists
    console.log("Getting playlists...");
    const playlists = await getFromCacheOrLoad("_playlists.json", async () =>
        (await getPlaylists()).filter((list) => !list.collaborative && list.owner.id === user)
    );

    // Saved Tracks
    console.log("\n\nGetting saved tracks...");
    const savedTracks = await getFromCacheOrLoad("_saved_tracks.json", getSavedTracks);

    const yearPlaylists = {};
    const yearSongs = {};
    const yearAddSongs = {};
    const pls = playlists;

    console.log("\n\nSorting years...");
    for (const track of savedTracks) {
        printProgress(Math.round((savedTracks.indexOf(track) / savedTracks.length) * 100));
        const rawYear = track.track.album.release_date.split("-")[0];
        const year = Number(rawYear) >= 2018 ? rawYear : `${rawYear.substring(0, 3)}0s`;

        const playlist = yearPlaylists[year] || pls.find((pl) => pl.name === year) || (await createPlaylist(year));
        const songs =
            yearSongs[year] ||
            (await getFromCacheOrLoad(`_${year}.json`, async () => await getSongsForPlaylist(playlist, false), year));

        if (!yearPlaylists[year]) yearPlaylists[year] = playlist;
        if (!yearSongs[year]) yearSongs[year] = songs;

        if (songs.find((plTrack) => plTrack.track.id === track.track.id)) continue;
        yearAddSongs[playlist.id] = [...(yearAddSongs[playlist.id] || []), track];
    }

    // Songs in Eyes playlist
    console.log("\n\nGetting 👀 list...");
    const eyesPlaylist = playlists.find((playlist) => playlist.name === "👀") || (await createPlaylist("👀"));

    const eyesPlaylistTracks = await getFromCacheOrLoad(
        "./_eyes_tracks.json",
        async () => await getSongsForPlaylist(eyesPlaylist, true)
    );

    // Playlist Songs
    console.log("\n\nGetting playlisted songs...");
    const regex = /\d{4}.?/;
    const filterAndSortPlaylisted = async (playlists) => {
        const otherPlaylistTracks = [];
        const playlistsToFetch = playlists.filter(
            (playlist) => playlist.name !== "Unplaylisted" && playlist.name !== "👀" && !regex.test(playlist.name)
        );
        for (const playlist of playlistsToFetch) {
            const tracks = yearSongs[playlist.name] || (await getSongsForPlaylist(playlist, false));
            otherPlaylistTracks.push(tracks);
            printProgress(Math.round((playlistsToFetch.indexOf(playlist) / playlistsToFetch.length) * 100));
        }

        return otherPlaylistTracks.reduce((acc, curr) => [...acc, ...curr], []);
    };
    const playlistedTracks = await getFromCacheOrLoad("_playlisted_tracks.json", () =>
        filterAndSortPlaylisted(playlists)
    );

    // Songs in Unplaylisted List
    console.log("\n\nGetting Unplaylisted list...");
    const unplaylistedPlaylist =
        playlists.find((playlist) => playlist.name === "Unplaylisted") || (await createPlaylist());
    const trackedUnplaylistedSongs = await getFromCacheOrLoad(
        "./_unplaylisted_tracks.json",
        async () => await getSongsForPlaylist(unplaylistedPlaylist, true)
    );

    return {
        savedTracks,
        playlists,
        unplaylistedPlaylist,
        playlistedTracks,
        trackedUnplaylistedSongs,
        eyesPlaylist,
        eyesPlaylistTracks,
        yearAddSongs,
        playlists,
    };
}

async function removePlaylisted(trackedUnplaylistedSongs, playlistedTracks, unplaylistedPlaylist) {
    const hasBeenPlaylisted = trackedUnplaylistedSongs.filter((track) =>
        playlistedTracks.some((savedTrack) => savedTrack.track.id === track.track.id)
    );
    console.log("Tracks that have been Playlisted: ", hasBeenPlaylisted.length);

    if (hasBeenPlaylisted.length > 0) emptyCache("_unplaylisted_tracks");

    const chunks = [...Array(Math.ceil(hasBeenPlaylisted.length / 100))].map((_) => hasBeenPlaylisted.splice(0, 100));

    for (let chunk of chunks) {
        await removeTracksFromPlaylist(unplaylistedPlaylist, chunk);
    }
}

async function addUnplaylisted(savedTracks, playlistedTracks, trackedUnplaylistedSongs, unplaylistedPlaylist) {
    const unplaylisted = savedTracks.filter(
        (saved) =>
            !playlistedTracks.some((plTrack) => plTrack.track.id == saved.track.id) &&
            !trackedUnplaylistedSongs.some((plTrack) => plTrack.track.id == saved.track.id)
    );
    console.log("Tracks not in Playlists: ", unplaylisted.length, "\n");

    if (unplaylisted.length > 0) emptyCache("_unplaylisted_tracks");

    const chunks = [...Array(Math.ceil(unplaylisted.length / 100))].map((_) => unplaylisted.splice(0, 100));

    for (let chunk of chunks) {
        await addTracksToPlaylist(unplaylistedPlaylist, chunk);
    }
}

async function removeLiked(eyesPlaylist, eyesPlaylistTracks, savedTracks) {
    const likedTracks = eyesPlaylistTracks.filter((eyeTrack) =>
        savedTracks.some((savedTrack) => savedTrack.track.id === eyeTrack.track.id)
    );

    console.log("\n\nTracks to remove from 👀: ", likedTracks.length);

    if (likedTracks.length > 0) emptyCache("_eyes_tracks");

    const chunks = [...Array(Math.ceil(likedTracks.length / 100))].map((_) => likedTracks.splice(0, 100));

    for (let chunk of chunks) {
        await removeTracksFromPlaylist(eyesPlaylist, chunk);
    }
}

const preArgs = {
    r: () => {
        emptyCache("_saved_tracks");
        emptyCache("_playlisted_tracks");
    },
    c: () => {
        emptyCache("_playlisted_tracks");
    },
    f: () => {
        fs.readdirSync("./_cache").forEach((file) => {
            fs.unlinkSync(`./_cache/${file}`);
        });
    },
    h: () => {
        console.log(`
-r: Refresh saved_tracks and playlisted_tracks
-c: Refresh playlisted_tracks
-f: Empty entire cache
-u: Update Unplaylisted playlist
-y: Update decades playlists
-e: Update 👀 playlist
-h: Display this message
        `);
        process.exit();
    },
};

const postArgs = {
    u: async ({ trackedUnplaylistedSongs, playlistedTracks, unplaylistedPlaylist, savedTracks }) => {
        await removePlaylisted(trackedUnplaylistedSongs, playlistedTracks, unplaylistedPlaylist);
        await addUnplaylisted(savedTracks, playlistedTracks, trackedUnplaylistedSongs, unplaylistedPlaylist);
    },
    y: async ({ yearAddSongs }) => {
        console.log("\n\nAdding year songs...");
        for (const year of Object.keys(yearAddSongs)) {
            const yearSongs = yearAddSongs[year];

            if (yearSongs.length > 0) emptyCache(year);

            const chunks = [...Array(Math.ceil(yearSongs.length / 100))].map((_) => yearSongs.splice(0, 100));

            for (let chunk of chunks) {
                await addTracksToPlaylist({ id: year }, chunk);
            }
        }
    },
    e: async ({ eyesPlaylist, eyesPlaylistTracks, savedTracks }) => {
        await removeLiked(eyesPlaylist, eyesPlaylistTracks, savedTracks);
    },
};

async function main() {
    // const refresh = process.argv.find((flag) => flag == "-r");
    // const catCheck = process.argv.find((flag) => flag == "-c");
    // const force = process.argv.find((flag) => flag == "-f");

    // // Add songs to Unplaylisted, and remove songs from Unplaylisted
    // if (refresh) {
    //     emptyCache("_saved_tracks");
    //     emptyCache("_playlisted_tracks");
    // }

    // // Only remove songs from Unplaylisted
    // if (catCheck) {
    //     emptyCache("_playlisted_tracks");
    // }

    // // Start fresh
    // if (force) {
    //     fs.readdirSync("./_cache").forEach((file) => {
    //         fs.unlinkSync(`./_cache/${file}`);
    //     });
    // }

    const data = await loadData();

    for (const flag of Object.keys(postArgs)) {
        if (!flags.includes(flag)) continue;
        await postArgs[flag](data);
    }

    // console.log("\n\nAdding year songs...");
    // for (const year of Object.keys(yearAddSongs)) {
    //     const yearSongs = yearAddSongs[year];

    //     if (yearSongs.length > 0) emptyCache(year);

    //     const chunks = [...Array(Math.ceil(yearSongs.length / 100))].map((_) => yearSongs.splice(0, 100));

    //     for (let chunk of chunks) {
    //         await addTracksToPlaylist({ id: year }, chunk);
    //     }
    // }

    // await removeLiked(eyesPlaylist, eyesPlaylistTracks, savedTracks);

    // await removePlaylisted(trackedUnplaylistedSongs, playlistedTracks, unplaylistedPlaylist);

    // await addUnplaylisted(savedTracks, playlistedTracks, trackedUnplaylistedSongs, unplaylistedPlaylist);

    // Typescript
}

const express = require("express");
const app = express();
app.get("/callback", async (req, res) => {
    const code = req.query.code;
    res.set("Content-Type", "text/html");
    res.send(Buffer.from("<script>window.close();</script>"));

    const url = `https://accounts.spotify.com/api/token`;
    const body = new URLSearchParams({
        code,
        redirect_uri: "http://localhost:8888/callback",
        grant_type: "authorization_code",
    });

    const response = await fetch(url, {
        method: "POST",
        headers: {
            Authorization: "Basic " + Buffer.from(id + ":" + secret).toString("base64"),
        },
        body,
    });
    const resBody = await response.json();
    token = resBody.access_token;
    await main();
    process.exit(0);
});

const flags = process.argv[2];
if (!flags) return;

for (const flag of Object.keys(preArgs)) {
    if (!flags.includes(flag)) continue;
    preArgs[flag]();
}

app.listen(8888, () => {
    console.log("Server listening on port 8888!\n");
    open(url);
});
