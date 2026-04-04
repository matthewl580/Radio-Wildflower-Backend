// DEPENDECIES
const fs = require("fs");
const https = require("https");
const mp3Duration = require("mp3-duration");
const firebase = require("firebase/app");
const path = require("path");
const crypto = require("crypto");
const dotenv = require("dotenv");
dotenv.config();

// IMPORTANT - Fastly
const fastify = require("fastify")({ logger: false });
fastify.register(require("@fastify/static"), {
  root: path.join(__dirname, "public"),
  prefix: "/",
});
fastify.register(require("@fastify/formbody"));
fastify.register(require("@fastify/view"), {
  engine: {
    handlebars: require("handlebars"),
  },
});
fastify.register(require("@fastify/cors"), {
  origin: "https://radiowildflower.netlify.app",
  methods: ["GET", "POST", "OPTIONS", "PUT", "PATCH", "DELETE"],
  allowedHeaders: ["X-Requested-With", "Content-Type"],
  credentials: true,
});

const getAppCheck = require("firebase-admin/app-check");

const {
  initializeApp,
  applicationDefault,
  cert,
} = require("firebase-admin/app");
const {
  getFirestore,
  Timestamp,
  FieldValue,
  Filter,
  ref,
} = require("firebase-admin/firestore");
const {
  getStorage,
  uploadBytes,
  getDownloadURL,
} = require("firebase-admin/storage");

const serviceAccount = {
  type: "service_account",
  project_id: process.env.PROJECT_ID,
  private_key_id: process.env.SERVICE_ACCOUNT_PRIVATE_KEY_ID,
  private_key: process.env.SERVICE_ACCOUNT_PRIVATE_KEY.replace(
    /\\NEWLINE/g,
    "\n",
  ),
  client_email: process.env.CLIENT_EMAIL,
  client_id: process.env.SERVICE_ACCOUNT_CLIENT_ID,
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: process.env.CLIENT_X509_CERT_URL,
  universe_domain: "googleapis.com",
};

const app = initializeApp({
  credential: cert(serviceAccount),
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET_NAME,
});

const storage = getStorage(app);

async function getStorageFile(file, callback = () => {}) {
  const fileRef = getStorage()
    .bucket(process.env.FIREBASE_STORAGE_BUCKET_NAME)
    .file(file);
  const downloadURL = await getDownloadURL(fileRef);
  callback(file);
  return await downloadURL;
}

async function deleteStorageFile(filePath, callback = () => {}) {
  return storage
    .bucket()
    .file(filePath)
    .delete()
    .then((data) => {
      callback(data);
    });
}

async function readTracklistFromStorage() {
  try {
    const fileRef = storage.bucket().file("Tracks/TRACKLIST.json");
    const [exists] = await fileRef.exists();
    if (!exists) {
      console.log("📄 | TRACKLIST.json not found, returning empty array");
      return [];
    }

    const [content] = await fileRef.download();
    const tracklist = JSON.parse(content.toString());
    if (!Array.isArray(tracklist)) {
      console.warn("⚠️ | Invalid TRACKLIST.json format, returning empty");
      return [];
    }
    console.log(`✅ | Loaded ${tracklist.length} tracks from TRACKLIST.json`);
    return tracklist;
  } catch (err) {
    console.error("🔥 | readTracklistFromStorage error:", err.message);
    return [];
  }
}

async function writeTracklistToStorage(tracklist) {
  try {
    if (!Array.isArray(tracklist)) {
      throw new Error("tracklist must be an array");
    }
    const content = JSON.stringify(tracklist, null, 2);
    const fileRef = storage.bucket().file("Tracks/TRACKLIST.json");
    await fileRef.save(content, {
      metadata: { contentType: "application/json" },
    });
    console.log(`✅ | Wrote ${tracklist.length} tracks to TRACKLIST.json`);
  } catch (err) {
    console.error("🔥 | writeTracklistToStorage error:", err.message);
    throw err;
  }
}

async function appendToTracklist(newEntry) {
  const tracklist = await readTracklistFromStorage();
  tracklist.push(newEntry);
  await writeTracklistToStorage(tracklist);
  return tracklist;
}

async function removeFromTracklist(trackId) {
  const tracklist = await readTracklistFromStorage();
  const initialLength = tracklist.length;
  const newList = tracklist.filter((entry) => entry["Track ID"] !== trackId);
  if (newList.length !== initialLength) {
    await writeTracklistToStorage(newList);
    console.log(`✅ | Removed track ${trackId} from TRACKLIST`);
    return newList;
  }
  return tracklist;
}

async function reorderTracklist(newOrderIds) {
  const tracklist = await readTracklistFromStorage();
  const idMap = new Map(tracklist.map((entry) => [entry["Track ID"], entry]));
  const newList = newOrderIds.map((id) => idMap.get(id)).filter(Boolean);
  await writeTracklistToStorage(newList);
  console.log(`✅ | Reordered TRACKLIST to ${newList.length} tracks`);
  return newList;
}

const db = getFirestore();

function getDatabaseFile(collection, fileName, func = () => {}) {
  db.collection(collection)
    .doc(fileName)
    .get()
    .then((doc) => {
      func(doc.data());
      return doc.data();
    });
}

function setDatabaseFile(collection, fileName, data) {
  console.log(`🗒️ | Setting /{collection}/{fileName} to:  ${data}`);
  // Return the Promise so callers can await this operation
  return db.collection(collection).doc(fileName).set(data);
}

// ============================================================= FIRESTORE-BASED AUTHOR MANAGEMENT
// Authors stored in Firestore under Authors/ collection
// Each author document contains: Author Handle, Author ID, Songs (array of {id, title}), Created At

async function getOrCreateAuthor(authorName) {
  if (!authorName) {
    console.warn(`⚠️ | getOrCreateAuthor: Author name is empty or null`);
    return null;
  }

  try {
    console.log(`🔍 | Searching Firestore for author: "${authorName}"`);

    // Query Firestore for existing author by name
    const snapshot = await db
      .collection("Authors")
      .where("Author Handle", "==", authorName)
      .limit(1)
      .get();

    if (!snapshot.empty) {
      const doc = snapshot.docs[0];
      console.log(
        `✅ | Author already exists in Firestore: "${authorName}" -> ${doc.id}`,
      );
      console.log(
        `   📊 | Current songs count: ${doc.data()["Songs"]?.length || 0}`,
      );
      return { id: doc.id, data: doc.data() };
    }

    // Create new author
    console.log(`🆕 | Author not found. Creating new author: "${authorName}"`);
    const authorId = crypto.randomUUID();
    const authorData = {
      "Author Handle": authorName,
      "Author ID": authorId,
      Songs: [], // Array of {id, title}
      Description: "", // Optional field for future use
      profileImageURL: "", // Optional field for future use
      genres: [], // Optional field for future use
      "Created At": new Date(),
    };

    await db.collection("Authors").doc(authorId).set(authorData);
    console.log(`✅ | Successfully created new author in Firestore`);
    console.log(`   📝 | Author Handle: ${authorName}`);
    console.log(`   🆔 | Author ID: ${authorId}`);
    return { id: authorId, data: authorData };
  } catch (err) {
    console.error(
      `🔥 | ERROR in getOrCreateAuthor for "${authorName}":`,
      err.message,
    );
    console.error(`   Stack: ${err.stack}`);
    return null;
  }
}

async function addSongToAuthor(authorId, songId, songTitle) {
  if (!authorId || !songId || !songTitle) {
    console.warn(
      `⚠️ | addSongToAuthor: Missing required parameters` +
        `   authorId: ${authorId ? "✓" : "✗"}, songId: ${songId ? "✓" : "✗"}, songTitle: ${songTitle ? "✓" : "✗"}`,
    );
    return false;
  }

  try {
    console.log(
      `📝 | Adding song to author: authorId=${authorId.substring(0, 8)}...`,
    );
    console.log(`   🎵 | Song: "${songTitle}" (${songId.substring(0, 8)}...)`);

    const authorRef = db.collection("Authors").doc(authorId);
    const doc = await authorRef.get();

    if (!doc.exists) {
      console.warn(
        `⚠️ | Author document does not exist in Firestore: ${authorId}`,
      );
      return false;
    }

    const authorData = doc.data();
    const songs = Array.isArray(authorData["Songs"]) ? authorData["Songs"] : [];
    const authorHandle = authorData["Author Handle"] || "Unknown";

    // Check if song already exists
    const songExists = songs.some((s) => s.id === songId);
    if (songExists) {
      console.log(
        `ℹ️ | Song already in author's collection. Skipping duplicate.`,
      );
      console.log(`   👤 | Author: ${authorHandle}`);
      console.log(`   🎵 | Song: ${songTitle}`);
      return true;
    }

    // Add song to author's list
    songs.push({ id: songId, title: songTitle });
    await authorRef.update({ Songs: songs });
    console.log(`✅ | Successfully added song to author`);
    console.log(`   👤 | Author: ${authorHandle}`);
    console.log(`   🎵 | Song: ${songTitle}`);
    console.log(`   📊 | Total songs for author: ${songs.length}`);
    return true;
  } catch (err) {
    console.error(`🔥 | ERROR in addSongToAuthor:`, err.message);
    console.error(`   Stack: ${err.stack}`);
    return false;
  }
}

async function getAuthorByHandle(authorHandle) {
  if (!authorHandle) {
    console.warn(`⚠️ | getAuthorByHandle: Author handle is empty`);
    return null;
  }

  try {
    console.log(`🔍 | Fetching author by handle: "${authorHandle}"`);

    const snapshot = await db
      .collection("Authors")
      .where("Author Handle", "==", authorHandle)
      .limit(1)
      .get();

    if (!snapshot.empty) {
      const doc = snapshot.docs[0];
      console.log(
        `✅ | Found author: ID=${doc.id.substring(0, 8)}..., Songs=${doc.data()["Songs"]?.length || 0}`,
      );
      return { id: doc.id, data: doc.data() };
    }

    console.log(`ℹ️ | Author not found: "${authorHandle}"`);
    return null;
  } catch (err) {
    console.error(`🔥 | ERROR in getAuthorByHandle:`, err.message);
    return null;
  }
}

async function getAllAuthors() {
  try {
    console.log(`📚 | Fetching all authors from Firestore...`);

    const snapshot = await db.collection("Authors").get();
    const authors = [];
    snapshot.forEach((doc) => {
      authors.push({ id: doc.id, ...doc.data() });
    });

    console.log(`✅ | Retrieved ${authors.length} author(s) from Firestore`);
    authors.forEach((author, idx) => {
      console.log(
        `   ${idx + 1}. "${author["Author Handle"]}" - ${author["Songs"]?.length || 0} song(s)`,
      );
    });
    return authors;
  } catch (err) {
    console.error(`🔥 | ERROR in getAllAuthors:`, err.message);
    return [];
  }
}

async function getAuthorById(authorId) {
  if (!authorId) {
    console.warn(`⚠️ | getAuthorById: Author ID is empty`);
    return null;
  }

  try {
    console.log(`🔍 | Fetching author by ID: ${authorId.substring(0, 8)}...`);

    const doc = await db.collection("Authors").doc(authorId).get();
    if (doc.exists) {
      console.log(`✅ | Found author: "${doc.data()["Author Handle"]}"`);
      return { id: doc.id, data: doc.data() };
    }

    console.log(`ℹ️ | Author not found with ID: ${authorId}`);
    return null;
  } catch (err) {
    console.error(`🔥 | ERROR in getAuthorById:`, err.message);
    return null;
  }
}

async function loadTracklistFromFirestore() {
  try {
    const doc = await db.collection("Tracks").doc("TRACKLIST").get();
    if (doc.exists) {
      const data = doc.data();
      if (Array.isArray(data.tracklist)) {
        const trackIds = data.tracklist
          .map((item) => item["Track ID"])
          .filter(Boolean);
        radioStation.trackList = trackIds;
        console.log(`✅ Loaded ${trackIds.length} tracks from TRACKLIST`);
        return trackIds;
      } else {
        console.warn("⚠️ TRACKLIST data invalid, using empty");
      }
    } else {
      console.log("📝 Creating empty TRACKLIST doc");
      await db.collection("Tracks").doc("TRACKLIST").set({ tracklist: [] });
      console.log("✅ TRACKLIST doc created");
    }
    radioStation.trackList = [];
    return [];
  } catch (err) {
    console.error("🔥 loadTracklistFromFirestore:", err.message);
    radioStation.trackList = [];
    return [];
  }
}

//============================================================= START OF ACTUAL CODE

// Single radio station configuration
const radioStation = {
  name: "Wildflower Radio",
};
console.log(
  `ℹ️ | Configured single radio station: ${radioStation.name} (trackList from Storage JSON)`,
);

var RadioManager = [
  {
    name: radioStation.name,
    trackNum: 0,
    currentTrackId: null,
    trackObject: {
      // Track object specific to this radio station
      currentSegment: { duration: undefined, position: undefined, SRC: "" },
      track: {
        segmentDurations: [],
        numSegments: undefined,
        numCurrentSegment: undefined,
        author: "",
        title: "",
        duration: undefined,
        position: undefined,
        SRC: "",
      },
    },
  },
];

async function start() {
  console.log(
    `🟢 | Starting radio manager for ${RadioManager.length} station(s)`,
  );
  // Ensure initial TRACKLIST.json exists
  await writeTracklistToStorage([]);
  RadioManager.forEach((radio) => console.log(`→ Station: ${radio.name}`));
  RadioManager.forEach((radio) => playRadioStation(radio)); // Play all stations simultaneously
}

function playRadioStation(radioStation) {
  console.log(`▶️ | playRadioStation() called for ${radioStation.name}`);
  // Use the radio object's trackNum as the authoritative current track index
  if (typeof radioStation.trackNum !== "number") radioStation.trackNum = -1;
  // Flag to indicate immediate stop of current playback
  radioStation._stopCurrent = false;

  async function nextTrack(radio) {
    const tracklist = await readTracklistFromStorage();
    if (tracklist.length === 0) {
      console.warn(`⚠️ | ${radio.name} has empty tracklist.`);
      return;
    }

    radio.trackNum = (radio.trackNum + 1) % tracklist.length;
    const trackEntry = tracklist[radio.trackNum];
    const trackId = trackEntry["Track ID"];

    console.log(
      `⏭️ | ${radio.name} - Playing next track #${radio.trackNum + 1}: ${trackEntry["Track Name"]} (ID: ${trackId.substring(0, 8)}...)`,
    );

    const oldTrackId = radio.currentTrackId;
    radio.currentTrackId = trackId;

    if (oldTrackId && oldTrackId === trackId) {
      console.log(
        `⏯️ | ${radio.name} - Continuing same track ${trackId.substring(0, 8)}... (trackNum advanced)`,
      );
      return; // No interrupt needed
    }

    console.log(
      `⏹️→▶️ | ${radio.name} - Interrupt: switching to ${trackEntry["Track Name"]} (ID: ${trackId.substring(0, 8)}...)`,
    );

    radio.trackObject = {
      currentSegment: { duration: 0, position: 0, SRC: "" },
      track: {
        segmentDurations: [],
        numSegments: 0,
        numCurrentSegment: 0,
        author: "",
        title: "",
        duration: 0,
        position: 0,
        SRC: "",
      },
    };

    radio._stopCurrent = false;

    // Load full track data from Firestore
    try {
      const trackDoc = await db.collection("Tracks").doc(trackId).get();
      const trackData = trackDoc.exists ? trackDoc.data() : null;
      if (!trackData) {
        console.warn(`⚠️ | No track data for ID: ${trackId}`);
        radio.currentTrackId = null;
        return nextTrack(radio); // Skip invalid
      }
      playTrack(radio, trackData);

      // Queue rotation: move played track to end of tracklist (User Task 2)
      try {
        const freshTracklist = await readTracklistFromStorage();
        if (freshTracklist.length > 0) {
          const playedId = trackId;
          const withoutPlayed = freshTracklist.filter(
            (entry) => entry["Track ID"] !== playedId,
          );
          const newOrderIds = [
            ...withoutPlayed.map((e) => e["Track ID"]),
            playedId,
          ];
          await reorderTracklist(newOrderIds);
          console.log(
            `🔄 | ${radio.name} - Moved played track ${playedId.substring(0, 8)}... to end (${newOrderIds.length} tracks)`,
          );
        }
      } catch (rotateErr) {
        console.error(
          `🔥 | Queue rotation failed for ${trackId.substring(0, 8)}...:`,
          rotateErr.message,
        );
      }
    } catch (err) {
      console.error(`🔥 | Error loading track ${trackId}:`, err);
      radio.currentTrackId = null;
      nextTrack(radio);
    }
  }

  // Expose nextTrack so external code (admin endpoint) can trigger immediate start
  radioStation._nextTrack = () => nextTrack(radioStation);
  // Clear gentle stop flags when starting new track
  radioStation._finishCurrentSegment = false;
  radioStation._gentleStop = () => {
    radioStation._finishCurrentSegment = true;
    console.log(
      `⏸️ | ${radioStation.name} - gentleStop invoked (finish current segment)`,
    );
  };

  radioStation._stop = () => {
    radioStation._stopCurrent = true;
    // If a cancellable sleep is active, cancel it to stop immediately
    try {
      if (radioStation._currentSleepTimer) {
        clearTimeout(radioStation._currentSleepTimer);
        radioStation._currentSleepTimer = null;
      }
      if (typeof radioStation._currentSleepResolver === "function") {
        // Resolve the pending sleep so any awaiting logic continues immediately
        radioStation._currentSleepResolver();
        radioStation._currentSleepResolver = null;
      }
    } catch (e) {
      console.error("🔥 | Error while stopping playback:", e);
    }
    console.log(`⏸️ | ${radioStation.name} - _stop invoked`);
  };

  // Helper: cancellable sleep that can be aborted by calling radioStation._stop()
  function cancellableSleep(radio, ms) {
    return new Promise((resolve) => {
      // store resolver and timer on the radio object so _stop can cancel
      radio._currentSleepResolver = resolve;
      radio._currentSleepTimer = setTimeout(() => {
        radio._currentSleepResolver = null;
        radio._currentSleepTimer = null;
        resolve();
      }, ms);
    });
  }

  async function playTrack(radio, trackData) {
    console.log(`🎵 | ${radio.name} - Playing track: ${trackData.Title}`);

    if (!trackData) {
      console.warn(`⚠️ | ${radio.name} - Invalid trackData`);
      if (!radio._stopCurrent) nextTrack(radio);
      return;
    }

    radio.trackObject.track.numSegments = trackData["Number of Segments"];
    radio.trackObject.track.duration = trackData["Total Track Duration"];
    radio.trackObject.track.title = trackData.Title;
    radio.trackObject.track.author = trackData["Author Handle"];
    radio.trackObject.track.SRC = trackData["Storage Reference URL"];
    radio.trackObject.track.segmentDurations = trackData["Segment Durations"];
    console.log(
      `ℹ️ | ${radio.name} - Track source: ${radio.trackObject.track.SRC}, segments: ${radio.trackObject.track.segmentDurations.length}`,
    );

    await playSegments(radio);
    if (!radio._stopCurrent) {
      nextTrack(radio);
    }
  }

  async function playSegments(radio) {
    radio.trackObject.track.numCurrentSegment = 0;
    let currentTrackPosition = 0;
    console.log(
      `ℹ️ | ${radio.name} - playSegments starting, numSegments: ${radio.trackObject.track.numSegments}`,
    );

    for (let i = 1; i <= radio.trackObject.track.numSegments; i++) {
      if (radio._stopCurrent) {
        console.log(`⏹️ | ${radio.name} - Playback stopped mid-track.`);
        break;
      }
      try {
        radio.trackObject.currentSegment.duration = Math.trunc(
          radio.trackObject.track.segmentDurations[i - 1],
        );
        console.log(
          `ℹ️ | ${radio.name} - Segment #${i} duration (truncated): ${radio.trackObject.currentSegment.duration}`,
        );
        if (!radio.trackObject.currentSegment.duration) {
          console.warn(`⚠️ | WARN - Segment #${i} duration missing.`);
          // FIRST attempt, only works if this is the last chunk
          if (
            radio.trackObject.numCurrentSegment >= radio.trackObject.numSegments
          ) {
            radio.trackObject.currentSegment.duration =
              1 +
              (radio.trackObject.track.duration -
                radio.trackObject.numCurrentSegment *
                  (radio.trackObject.numSegments - 1));
            console.log(
              "RECIFING with last segment duration calculations (safe)",
            );
          } else {
            // so we may not be at the last segment, lets use the one before us as a placeholder
            if (radio.trackObject.numCurrentSegment != 0) {
              radio.trackObject.currentSegment.duration =
                radio.trackObject.track.segmentDurations[
                  radio.trackObject.numCurrentSegment - 1
                ];
              console.log("RECIFING using previous segment length");
            } else {
              // there is nothing we can do
              radio.trackObject.currentSegment.duration = 28;
              console.log("RECIFING FAILED. Forcing duration to be 28 seconds");
            }
          }
        }
        await playSegment(
          radio,
          radio.trackObject.currentSegment,
          currentTrackPosition,
        );
        currentTrackPosition += radio.trackObject.currentSegment.duration;
      } catch (error) {
        console.error(`🔥 | ERROR - Playing segment #${i}: ${error.message}`);
        // Consider if you want to skip the segment or the entire track on error
      }
    }
  }

  async function playSegment(radio, segment, trackPosition) {
    console.log(
      `🎵 | ${radio.name} - Playing segment #${radio.trackObject.track.numCurrentSegment}`,
    );
    radio.trackObject.track.numCurrentSegment++;
    const chunkPath = `${radio.trackObject.track.SRC}/Chunk_${radio.trackObject.track.numCurrentSegment}.mp3`;
    console.log(
      `ℹ️ | ${radio.name} - Fetching segment from storage: ${chunkPath}`,
    );
    const segmentData = await getStorageFile(chunkPath);
    radio.trackObject.currentSegment.SRC = segmentData;
    radio.trackObject.currentSegment.position = 0; // Reset segment position HERE

    // Simulate playback and position tracking (REPLACE THIS WITH ACTUAL AUDIO PLAYBACK LOGIC)
    for (let position = 0; position < segment.duration; position++) {
      if (radio._stopCurrent) {
        console.log(`⏹️ | ${radio.name} - Stopping segment playback.`);
        break;
      }
      if (radio._finishCurrentSegment && position >= segment.duration - 2) {
        console.log(
          `🎯 | ${radio.name} - Finishing current segment due to gentleStop`,
        );
      }
      await cancellableSleep(radio, 1000);
      if (radio._stopCurrent) {
        console.log(`⏹️ | ${radio.name} - Stopping segment playback.`);
        break;
      }
      await cancellableSleep(radio, 1000); // Simulate 1-second increments with cancellable sleep
      radio.trackObject.currentSegment.position = position + 1;
      radio.trackObject.track.position = trackPosition + position + 1; // Update total track position
      console.log(
        `${radio.name} - Track Position: ${radio.trackObject.track.position}, Segment Position: ${radio.trackObject.currentSegment.position}`,
      );
    }
  }

  // Start the first track
  nextTrack(radioStation);
}

fastify.get("/getAllTrackInformation", async function (request, reply) {
  try {
    const allTrackInfo = {};
    // Gather info for each radio station (only 1 currently) and next track preview
    await Promise.all(
      RadioManager.map(async (radio) => {
        console.log(`ℹ️ | Gathering track info for ${radio.name}`);
        // Shallow clone to avoid mutating runtime state
        const info = JSON.parse(JSON.stringify(radio.trackObject));

        // Use pendingTrackList if available, else current trackList
        const effectiveTrackList = radio.pendingTrackList || radio.trackList;
        let nextTrackStorageURL = null;

        try {
          if (
            Array.isArray(effectiveTrackList) &&
            effectiveTrackList.length > 0
          ) {
            const nextIndex =
              typeof radio.trackNum === "number"
                ? (radio.trackNum + 1) % effectiveTrackList.length
                : 0;
            const nextId = effectiveTrackList[nextIndex];
            if (nextId) {
              const doc = await db
                .collection("Tracks")
                .doc(String(nextId))
                .get();
              const data = doc.exists ? doc.data() : null;
              nextTrackStorageURL =
                data?.["Storage Reference URL"] ||
                data?.storageReferenceURL ||
                null;
              console.log(
                `ℹ️ | ${radio.name} - Next track preview: ${nextTrackStorageURL ? nextId.substring(0, 8) + "..." : "none"} (${radio.pendingTrackList ? "pending" : "active"} list)`,
              );
            }
          }
        } catch (err) {
          console.error(
            `🔥 | ${radio.name} - Error fetching next track URL:`,
            err.message,
          );
        }

        info.nextTrackStorageURL = nextTrackStorageURL;
        allTrackInfo[radio.name] = info;
      }),
    );
    console.log(
      `ℹ️ | /getAllTrackInformation returning data for ${Object.keys(allTrackInfo).length} station(s):`,
      Object.keys(allTrackInfo),
    );

    reply.header("Content-Type", "application/json");
    return allTrackInfo;
  } catch (err) {
    console.error("🔥 | /getAllTrackInformation error:", err.message);
    reply.code(500).send({ error: "Failed to get track information" });
  }
});

// Returns the current radio station
fastify.get("/stations", function (request, reply) {
  try {
    // Return the single radio station info (name, trackList)
    reply.header("Content-Type", "application/json");
    return [radioStation];
  } catch (err) {
    console.error("🔥 | ERROR - getting stations:", err);
    reply.code(500).send({ error: "Failed to fetch stations" });
  }
});

// Returns a list of all tracks stored in Firestore `Tracks` collection
// Each item contains: title (doc id), author, duration
fastify.get("/getAllTracks", async function (request, reply) {
  try {
    const snapshot = await db.collection("Tracks").get();
    const tracks = [];
    snapshot.forEach((doc) => {
      const data = doc.data() || {};
      tracks.push({
        id: doc.id,
        title: data.Title || doc.id,
        author: data["Author Handle"] || null,
        authorId: data["Author ID"] || data.authorId || null,
        duration: data["Total Track Duration"] || null,
        storageURL:
          data["Storage Reference URL"] || data.storageReferenceURL || null,
      });
    });
    console.log(`ℹ️ | /getAllTracks returning ${tracks.length} tracks`);
    reply.header("Content-Type", "application/json");
    return tracks;
  } catch (err) {
    console.error("🔥 | ERROR - fetching Tracks collection:", err);
    reply.code(500).send({ error: "Failed to fetch tracks" });
  }
});

// Edit the trackList for a given radio station
// Protected under /admin so Basic Auth will be required by the existing hook
// Expects JSON body: { stationName: string, trackList: string[] | string }
fastify.post("/admin/editTrackList", async function (request, reply) {
  const body = request.body || {};
  const stationName = body.stationName;
  const trackListIds = body.trackList;
  console.log(
    `📝 | /admin/editTrackList for ${stationName}: ${trackListIds?.length || 0} IDs`,
  );

  if (!stationName) {
    return reply.code(400).send({ error: "stationName is required" });
  }
  if (!Array.isArray(trackListIds)) {
    return reply
      .code(400)
      .send({ error: "trackList must be array of track IDs" });
  }

  const radio = RadioManager.find((r) => r.name === stationName);
  if (!radio) {
    return reply.code(404).send({ error: "radio station not found" });
  }

  // Fetch full entries for the new order
  const newTracklist = [];
  for (const trackId of trackListIds) {
    try {
      const trackDoc = await db.collection("Tracks").doc(trackId).get();
      if (trackDoc.exists) {
        const trackData = trackDoc.data();
        const authorFull = await getAuthorById(trackData["Author ID"]);
        newTracklist.push({
          "Track Name": trackData.Title,
          Author: authorFull?.data || {},
          "Track ID": trackId,
          "track length": trackData["Total Track Duration"],
        });
      }
    } catch (err) {
      console.error(`Error fetching track ${trackId}:`, err);
    }
  }

  await writeTracklistToStorage(newTracklist);
  console.log(`✅ Reordered tracklist to ${newTracklist.length} tracks`);

  // Smart interrupt: check if first track changed
  const freshList = await readTracklistFromStorage();
  const firstId = freshList[0]?.["Track ID"];
  if (firstId && firstId !== radio.currentTrackId) {
    console.log(
      `⏹️→▶️ | Admin edit: first track changed ${radio.currentTrackId?.substring(0, 8)}... → ${firstId.substring(0, 8)}... → triggering nextTrack`,
    );
    if (radio._nextTrack) radio._nextTrack();
  } else {
    console.log(
      `⏯️ | Admin edit: first track same (${firstId?.substring(0, 8)}...), no interrupt`,
    );
  }

  return reply.send({
    success: true,
    station: radio.name,
    newLength: newTracklist.length,
  });
});

// Returns detailed track position + progress for *all* radio stations (includes % progress, current track)
fastify.get("/getAllTrackPositions", function (request, reply) {
  const allTrackPositions = {};
  RadioManager.forEach((radio) => {
    allTrackPositions[radio.name] = radio.trackObject.track.position;
  });
  return allTrackPositions;
});

// Returns segment position for *all* radio stations
fastify.get("/getAllSegmentPositions", function (request, reply) {
  const allSegmentPositions = {};
  RadioManager.forEach((radio) => {
    allSegmentPositions[radio.name] = radio.trackObject.currentSegment.position;
  });
  return allSegmentPositions;
});

fastify.post("/admin/reorderTracklist", async function (request, reply) {
  const { newOrder, stationName = "Wildflower Radio" } = request.body || {};
  if (!Array.isArray(newOrder)) {
    return reply
      .code(400)
      .send({ error: "newOrder array of track IDs required" });
  }

  const radio = RadioManager.find((r) => r.name === stationName);
  if (!radio) {
    return reply.code(404).send({ error: "station not found" });
  }

  // Reorder using helper
  const newTracklist = await reorderTracklist(newOrder);
  console.log(`🔄 Reordered to ${newTracklist.length} tracks`);

  // Smart interrupt
  const freshList = await readTracklistFromStorage();
  const firstId = freshList[0]?.["Track ID"];
  if (firstId && firstId !== radio.currentTrackId) {
    console.log(`⏹️→▶️ | Reorder: first changed → nextTrack`);
    if (radio._nextTrack) radio._nextTrack();
  } else {
    console.log(`⏯️ | Reorder: first same, no interrupt`);
  }

  return reply.send({
    success: true,
    newLength: newTracklist.length,
  });
});

fastify.post("/admin/deleteTrack", async function (request, reply) {
  const { trackId, stationName = "Wildflower Radio" } = request.body || {};
  if (!trackId) {
    return reply.code(400).send({ error: "trackId required" });
  }

  const radio = RadioManager.find((r) => r.name === stationName);
  if (!radio) {
    return reply.code(404).send({ error: "station not found" });
  }

  // Remove from tracklist
  await removeFromTracklist(trackId);

  // Delete Firestore track doc
  await db.collection("Tracks").doc(trackId).delete();

  // Delete author song reference
  const trackDoc = await db.collection("Tracks").doc(trackId).get();
  if (trackDoc.exists) {
    const trackData = trackDoc.data();
    const authorId = trackData["Author ID"];
    if (authorId) {
      await addSongToAuthor(authorId, trackId, trackData.Title); // Won't add since exists check
      // Note: full delete from author would require fetching songs list and filtering
    }
  }

  // Delete storage folder - recursive delete not directly supported, delete chunks
  const bucket = storage.bucket();
  const [files] = await bucket.getFiles({ prefix: `Tracks/${trackId}/` });
  await Promise.all(files.map((f) => f.delete()));

  console.log(`🗑️ Full delete of track ${trackId}`);

  // Smart interrupt after delete
  const freshList = await readTracklistFromStorage();
  const firstId = freshList[0]?.["Track ID"];
  if (firstId && firstId !== radio.currentTrackId) {
    console.log(`⏹️→▶️ | Delete: first changed → nextTrack`);
    if (radio._nextTrack) radio._nextTrack();
  } else {
    console.log(`⏯️ | Delete: first same, no interrupt`);
  }

  return reply.send({ success: true, deleted: trackId });
});

fastify.post("/admin/rejectTrack", async function (request, reply) {
  const { trackId, stationName = "Wildflower Radio" } = request.body || {};
  if (!trackId) {
    return reply.code(400).send({ error: "trackId required" });
  }

  const radio = RadioManager.find((r) => r.name === stationName);
  if (!radio) {
    return reply.code(404).send({ error: "station not found" });
  }

  const newTracklist = await removeFromTracklist(trackId);
  console.log(
    `🚫 Rejected track ${trackId}, new length: ${newTracklist.length}`,
  );

  // Smart interrupt after reject
  const freshList = await readTracklistFromStorage();
  const firstId = freshList[0]?.["Track ID"];
  if (firstId && firstId !== radio.currentTrackId) {
    console.log(`⏹️→▶️ | Reject: first changed → nextTrack`);
    if (radio._nextTrack) radio._nextTrack();
  } else {
    console.log(`⏯️ | Reject: first same, no interrupt`);
  }

  return reply.send({
    success: true,
    removed: true,
    newLength: newTracklist.length,
  });
});

fastify.post("/addTrack", function (request, reply) {
  if (request.body.authPassword !== "password") {
    // return; // incorrect password (disabled for the sake of debugging)
  }
  reply.header("Access-Control-Allow-Origin", "*");
  reply.header("Access-Control-Allow-Methods", "POST");

  // Generate a unique track ID
  const trackID = crypto.randomUUID();
  console.log(`🆔 | Generated Track ID: ${trackID}`);

  var trackChunkDurationArray = [];

  async function uploadTrackRefToDatabase(
    trackID,
    request,
    trackChunkDurationArray,
    numChunks,
  ) {
    console.log("🔘 | Trying to upload Track Ref to Database");
    try {
      const authorResult = await getOrCreateAuthor(request.body.author);
      const authorId = authorResult ? authorResult.id : null;
      return setDatabaseFile("Tracks", trackID, {
        "Storage Reference URL": `Tracks/${trackID}`,
        Title: request.body.title,
        "Author Handle": request.body.author,
        "Author ID": authorId,
        "Total Track Duration": request.body.duration,
        "Segment Durations": trackChunkDurationArray,
        "Number of Segments": numChunks,
        "Time Added": new Date(),
      });
    } catch (err) {
      console.error("🔥 | ERROR - uploadTrackRefToDatabase:", err);
    }
  }
  async function uploadMP3ToFirebase(filePath, destination) {
    try {
      console.log(`📤 | uploadMP3ToFirebase: ${filePath} -> ${destination}`);
      const storageRef = storage.bucket();
      const [response] = await storageRef.upload(filePath, {
        destination: destination,
        uploadType: "media",
        metadata: {
          contentType: "audio/mpeg",
        },
      });
      console.log(`✅ | Firebase upload successful: ${destination}`);
      return response;
    } catch (error) {
      console.error(`🔥 | ERROR uploadMP3ToFirebase:`, error);
      throw error;
    }
  }
  const chunkSize = 1 * 1024 * 1024; // 1 MB chunks (matching Firebase storage structure)
  const outputDir = "chunks"; // The output directory
  var chunkMediaDurationArray = [];
  if (!request.body.downloadURL) {
    console.error("Please provide a valid MP3 URL as an argument.");
    process.exit(1);
  }

  console.log(
    `📥 | /addTrack START: Downloading MP3 from ${request.body.downloadURL}`,
  );
  console.log(
    `📥 | Track: title="${request.body.title}", author="${request.body.author}", duration=${request.body.duration}s, trackID=${trackID}`,
  );

  https
    .get(request.body.downloadURL, async (response) => {
      if (response.statusCode !== 200) {
        console.error(`Error fetching MP3 from URL: ${response.statusCode}`);
        return reply.code(500).send({
          error: `Failed to download MP3: HTTP ${response.statusCode}`,
        });
      }
      console.log(
        `✅ | HTTP 200 OK - Beginning to stream & chunk the MP3 data`,
      );

      let currentChunk = 1;
      let chunkData = Buffer.alloc(0);
      let totalBytesReceived = 0;
      const chunks = []; // Store all chunks in memory or disk for processing

      response.on("data", (chunk) => {
        chunkData = Buffer.concat([chunkData, chunk]);
        totalBytesReceived += chunk.length;
        console.log(
          `📦 | Stream data: +${chunk.length}B (total: ${totalBytesReceived}B, buffer: ${chunkData.length}B)`,
        );

        // Process full chunks
        while (chunkData.length >= chunkSize) {
          const chunkBuffer = chunkData.slice(0, chunkSize);
          chunkData = chunkData.slice(chunkSize);
          chunks.push(chunkBuffer);
          console.log(
            `📑 | Chunk #${chunks.length} buffered (${chunkBuffer.length}B)`,
          );
        }
      });

      response.on("end", async () => {
        // Handle final remainder
        if (chunkData.length > 0) {
          chunks.push(chunkData);
          console.log(
            `📑 | Final chunk buffered (${chunkData.length}B, total chunks: ${chunks.length})`,
          );
        }

        console.log(
          `🟢 | Download complete! Total: ${totalBytesReceived}B, Final chunks ready: ${chunks.length}`,
        );

        // Now process all chunks sequentially
        try {
          console.log(`🔄 | Processing ${chunks.length} chunks...`);

          for (let i = 0; i < chunks.length; i++) {
            const chunkNum = i + 1;
            const chunkBuffer = chunks[i];
            const chunkFilename = `chunks/chunk-${chunkNum}.mp3`;

            console.log(
              `💾 | Processing chunk #${chunkNum}: Writing to disk (${chunkBuffer.length}B)...`,
            );
            fs.mkdirSync(outputDir, { recursive: true });
            fs.writeFileSync(chunkFilename, chunkBuffer);
            const stat = fs.statSync(chunkFilename);
            console.log(
              `✅ | Chunk #${chunkNum} written: ${chunkFilename} (${stat.size}B)`,
            );

            // Upload to Firebase
            console.log(`📤 | Uploading chunk #${chunkNum} to Firebase...`);
            try {
              await uploadMP3ToFirebase(
                chunkFilename,
                `Tracks/${trackID}/Chunk_${chunkNum}.mp3`,
              );
              console.log(`✅ | Chunk #${chunkNum} uploaded successfully`);

              // Calculate duration
              console.log(
                `⏱️ | Calculating duration for chunk #${chunkNum}...`,
              );
              const durationVal = await mp3Duration(chunkFilename);
              console.log(`⏱️ | Chunk #${chunkNum} duration: ${durationVal}s`);
              trackChunkDurationArray.push(durationVal);
              chunkMediaDurationArray.push(durationVal);
              console.log(
                `📊 | Durations updated: ${trackChunkDurationArray.length} total`,
              );

              // Delete temp file
              console.log(`🗑️ | Deleting temp file: ${chunkFilename}`);
              fs.unlinkSync(chunkFilename);
              console.log(`✅ | Temp file deleted`);
            } catch (err) {
              console.error(`🔥 | ERROR processing chunk #${chunkNum}:`, err);
              throw err;
            }
          }

          // All chunks processed, manage author and write final DB entry
          console.log(`🎨 | ══════════════════════════════════════════`);
          console.log(`🎨 | Setting up author in Firestore`);
          console.log(`🎨 | ══════════════════════════════════════════`);

          const authorResult = await getOrCreateAuthor(request.body.author);

          if (!authorResult) {
            throw new Error(
              `Failed to create/get author: ${request.body.author}`,
            );
          }

          const authorId = authorResult.id;
          console.log(`✅ | Author ready: ID=${authorId.substring(0, 8)}...`);

          console.log(`📁 | ══════════════════════════════════════════`);
          console.log(`📁 | Writing Track metadata to Firestore`);
          console.log(`📁 | ══════════════════════════════════════════`);

          await setDatabaseFile("Tracks", trackID, {
            "Storage Reference URL": `Tracks/${trackID}`,
            Title: request.body.title,
            "Author Handle": request.body.author,
            "Author ID": authorId,
            "Total Track Duration": request.body.duration,
            "Segment Durations": trackChunkDurationArray,
            "Number of Segments": chunks.length,
            "Time Added": new Date(),
          });
          console.log(`✅ | Track metadata written successfully`);
          console.log(`   🆔 | Track ID: ${trackID}`);
          console.log(`   📝 | Title: ${request.body.title}`);
          console.log(`   👤 | Author: ${request.body.author}`);
          console.log(`   📊 | Segments: ${chunks.length}`);
          console.log(`   ⏱️  | Duration: ${request.body.duration}s`);

          // Add song to author's song list
          console.log(`📋 | ══════════════════════════════════════════`);
          console.log(`📋 | Adding song to author's collection`);
          console.log(`📋 | ══════════════════════════════════════════`);

          const songAdded = await addSongToAuthor(
            authorId,
            trackID,
            request.body.title,
          );
          if (songAdded) {
            console.log(`✅ | Song successfully added to author's collection`);
          } else {
            console.warn(
              `⚠️ | Could not add song to author's collection (but track was saved to Firestore)`,
            );
          }

          // Add to TRACKLIST
          console.log(`📋 | Adding track to TRACKLIST`);
          const authorFull = await getAuthorById(authorId);
          if (authorFull) {
            const newEntry = {
              "Track Name": request.body.title,
              Author: authorFull.data,
              "Track ID": trackID,
              "track length": request.body.duration,
            };
            await appendToTracklist(newEntry);
            console.log(`✅ Added to TRACKLIST.json: ${trackID}`);
          } else {
            console.warn("⚠️ Could not fetch full author for TRACKLIST");
          }

          // Attempt to clean up source file from storage
          console.log(
            `🗑️ | Deleting source from storage: Tracks/FreshlyUploadedMP3File`,
          );
          try {
            await deleteStorageFile("Tracks/FreshlyUploadedMP3File", () => {
              console.log(`✅ | Source file deleted from storage`);
            });
          } catch (err) {
            console.warn(
              `⚠️ | Could not delete source file (may not exist):`,
              err.message,
            );
          }

          console.log(
            `✅✅✅ | /addTrack COMPLETE!   trackID: ${trackID}   total_chunks: ${chunks.length}   total_duration: ${request.body.duration}s   author: ${request.body.author}   title: ${request.body.title}✅✅✅`,
          );

          // Send success response
          return reply.send({
            success: true,
            trackID: trackID,
            title: request.body.title,
            chunks: chunks.length,
          });
        } catch (err) {
          console.error(`🔥 | FATAL ERROR in chunk processing:`, err);
          return reply
            .code(500)
            .send({ error: `Failed to process chunks: ${err.message}` });
        }
      });
    })
    .on("error", (error) => {
      console.error(
        `🔥 | Network error while downloading MP3: ${error.message}`,
      );
      return reply.code(500).send({ error: `Network error: ${error.message}` });
    });

  // Note: response is sent asynchronously after all processing completes
});

// ============================================================= TEST & ADMIN ENDPOINTS

// Endpoint to get all authors with their songs
fastify.get("/getAllAuthors", async function (request, reply) {
  try {
    console.log(`📡 | GET /getAllAuthors requested`);
    const authors = await getAllAuthors();
    reply.header("Content-Type", "application/json");
    console.log(`✅ | Returning ${authors.length} author(s)`);
    return { success: true, count: authors.length, authors: authors };
  } catch (err) {
    console.error("🔥 | ERROR - /getAllAuthors:", err.message);
    return reply.code(500).send({ error: "Failed to fetch authors" });
  }
});

// Endpoint to get a specific author by handle
fastify.get("/getAuthor/:handle", async function (request, reply) {
  try {
    const handle = decodeURIComponent(request.params.handle);
    console.log(`📡 | GET /getAuthor/${handle} requested`);

    if (!handle) {
      return reply.code(400).send({ error: "Author handle is required" });
    }

    const author = await getAuthorByHandle(handle);
    if (!author) {
      console.log(`⚠️ | Author not found: ${handle}`);
      return reply.code(404).send({ error: `Author not found: ${handle}` });
    }

    reply.header("Content-Type", "application/json");
    console.log(
      `✅ | Author found with ${author.data["Songs"]?.length || 0} songs`,
    );
    return { success: true, author: author };
  } catch (err) {
    console.error("🔥 | ERROR - /getAuthor:", err.message);
    return reply.code(500).send({ error: "Failed to fetch author" });
  }
});

// Endpoint to manually create an author
fastify.post("/createAuthor", async function (request, reply) {
  try {
    const authorName = request.body?.authorName;
    console.log(`📡 | POST /createAuthor requested for: ${authorName}`);

    if (!authorName) {
      return reply.code(400).send({ error: "authorName is required" });
    }

    const author = await getOrCreateAuthor(authorName);
    if (!author) {
      console.log(`❌ | Failed to create author: ${authorName}`);
      return reply.code(500).send({ error: "Failed to create author" });
    }

    console.log(`✅ | Author endpoint response prepared`);
    return { success: true, author: { id: author.id, ...author.data } };
  } catch (err) {
    console.error("🔥 | ERROR - /createAuthor:", err.message);
    return reply
      .code(500)
      .send({ error: "Failed to create author", details: err.message });
  }
});

// Endpoint to manually add a song to an author
fastify.post("/addSongToAuthor", async function (request, reply) {
  try {
    const { authorId, songId, songTitle } = request.body || {};
    console.log(`📡 | POST /addSongToAuthor requested`);
    console.log(`   authorId: ${authorId?.substring(0, 8)}...`);
    console.log(`   songId: ${songId?.substring(0, 8)}...`);
    console.log(`   songTitle: ${songTitle}`);
    if (!authorId || !songId || !songTitle) {
      return reply.code(400).send({
        error: "authorId, songId, and songTitle are all required",
        provided: { authorId, songId, songTitle },
      });
    }

    const success = await addSongToAuthor(authorId, songId, songTitle);
    console.log(
      `${success ? "✅" : "❌"} | Song endpoint result: success=${success}`,
    );
    return {
      success: success,
      message: success
        ? "Song added to author"
        : "Failed to add song to author",
      authorId: authorId,
      songId: songId,
      songTitle: songTitle,
    };
  } catch (err) {
    console.error("🔥 | ERROR - /addSongToAuthor:", err.message);
    return reply
      .code(500)
      .send({ error: "Failed to add song to author", details: err.message });
  }
});

// Run the server and report out to the logs
fastify.listen(
  { port: process.env.PORT, host: "0.0.0.0" },
  function (err, address) {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    console.log(`🟢 | Server starting on ${address}`);
    start(); // Start playing all radio stations
  },
);
