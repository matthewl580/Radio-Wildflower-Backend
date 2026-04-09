// DEPENDECIES
const fs = require("fs");
const https = require("https");
const mp3Duration = require("mp3-duration");
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

const { initializeApp, cert } = require("firebase-admin/app");
const {
  getFirestore,
  Timestamp,
  FieldValue,
} = require("firebase-admin/firestore");
const { getStorage, getDownloadURL } = require("firebase-admin/storage");

const serviceAccount = {
  type: "service_account",
  project_id: process.env.PROJECT_ID || "matthew-internet-radio",
  private_key_id: process.env.SERVICE_ACCOUNT_PRIVATE_KEY_ID,
  private_key: process.env.SERVICE_ACCOUNT_PRIVATE_KEY.replace(
    /\\NEWLINE/g,
    "\n",
  ),
  client_email: process.env.CLIENT_EMAIL,
  client_id: process.env.SERVICE_ACCOUNT_CLIENT_ID,
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url:
    process.env.AUTH_PROVIDER_X509_CERT_URL ||
    "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: process.env.CLIENT_X509_CERT_URL,
  universe_domain: "googleapis.com",
};

const app = initializeApp({
  credential: cert(serviceAccount),
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET_NAME,
});

const storage = getStorage(app);

async function getStorageFile(file, callback = () => {}) {
  const fileRef = storage
    .bucket(process.env.FIREBASE_STORAGE_BUCKET_NAME)
    .file(file);
  const downloadURL = await getDownloadURL(fileRef);
  callback(file);
  return downloadURL;
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

async function setDatabaseFile(collection, fileName, data) {
  console.log(`🗒️ | Setting /${collection}/${fileName}`);
  return db.collection(collection).doc(fileName).set(data);
}

//============================================================= MERGED AUTHOR MANAGEMENT

async function getOrCreateAuthor(authorName) {
  if (!authorName) return null;
  const snapshot = await db
    .collection("Authors")
    .where("Author Handle", "==", authorName)
    .limit(1)
    .get();
  if (!snapshot.empty) {
    const doc = snapshot.docs[0];
    return { id: doc.id, data: doc.data() };
  }
  const authorId = crypto.randomUUID();
  const authorData = {
    "Author Handle": authorName,
    "Author ID": authorId,
    Songs: [],
    "Created At": new Date(),
  };
  await db.collection("Authors").doc(authorId).set(authorData);
  return { id: authorId, data: authorData };
}

async function addSongToAuthor(authorId, songId, songTitle) {
  if (!authorId || !songId || !songTitle) return false;
  const authorRef = db.collection("Authors").doc(authorId);
  const doc = await authorRef.get();
  if (!doc.exists) return false;
  const authorData = doc.data();
  const songs = Array.isArray(authorData.Songs) ? authorData.Songs : [];
  if (songs.some((s) => s.id === songId)) return true;
  songs.push({ id: songId, title: songTitle });
  await authorRef.update({ Songs: songs });
  return true;
}

//============================================================= START OF EXAMPLE-BASED CODE

// Load radio stations from JSON so the list is editable and can be expanded
const radioStationsData = require(path.join(__dirname, "radioStations.json"));

var RadioManager = radioStationsData.map((rs) => ({
  name: rs.name,
  trackList: rs.trackList,
  trackNum: 0,
  trackObject: {
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
}));

function start() {
  RadioManager.forEach((radio) => playRadioStation(radio)); // Play all stations simultaneously
}

function playRadioStation(radioStation) {
  if (typeof radioStation.trackNum !== "number") radioStation.trackNum = -1;
  radioStation._stopCurrent = false;

  function nextTrack(radio) {
    if (!Array.isArray(radio.trackList) || radio.trackList.length === 0) {
      console.warn(`⚠️ | ${radio.name} has empty trackList.`);
      return;
    }

    radio.trackNum = (radio.trackNum + 1) % radio.trackList.length;
    const trackTitle = radio.trackList[radio.trackNum];

    console.log(
      `⏭️ | ${radio.name} - Playing next track (Track #${radio.trackNum + 1}): ${trackTitle}`,
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

    playTrack(radio, trackTitle);
  }

  radioStation._nextTrack = () => nextTrack(radioStation);
  radioStation._stop = () => {
    radioStation._stopCurrent = true;
    try {
      if (radioStation._currentSleepTimer) {
        clearTimeout(radioStation._currentSleepTimer);
        radioStation._currentSleepTimer = null;
      }
      if (typeof radioStation._currentSleepResolver === "function") {
        radioStation._currentSleepResolver();
        radioStation._currentSleepResolver = null;
      }
    } catch (e) {}
  };

  function cancellableSleep(radio, ms) {
    return new Promise((resolve) => {
      radio._currentSleepResolver = resolve;
      radio._currentSleepTimer = setTimeout(() => {
        radio._currentSleepResolver = null;
        radio._currentSleepTimer = null;
        resolve();
      }, ms);
    });
  }

  async function playTrack(radio, trackTitle) {
    console.log(`🎵 | ${radio.name} - Playing track: ${trackTitle}`);

    try {
      const trackData = await new Promise((resolve, reject) => {
        getDatabaseFile("Tracks", trackTitle, (data) => resolve(data));
      });

      radio.trackObject.track.numSegments = trackData.numChunks;
      radio.trackObject.track.duration = trackData.duration;
      radio.trackObject.track.title = trackData.title;
      radio.trackObject.track.author = trackData.author;
      radio.trackObject.track.SRC = trackData.storageReferenceURL;
      radio.trackObject.track.segmentDurations = trackData.chunksDuration;

      await playSegments(radio);
      if (!radio._stopCurrent) {
        nextTrack(radio);
      }
    } catch (error) {
      console.error(`🔥 | ERROR - Getting track data: ${error.message}`);
      if (!radio._stopCurrent) nextTrack(radio);
    }
  }

  async function playSegments(radio) {
    radio.trackObject.track.numCurrentSegment = 0;
    let currentTrackPosition = 0;

    for (let i = 1; i <= radio.trackObject.track.numSegments; i++) {
      if (radio._stopCurrent) {
        console.log(`⏹️ | ${radio.name} - Playback stopped mid-track.`);
        break;
      }
      try {
        radio.trackObject.currentSegment.duration = Math.trunc(
          radio.trackObject.track.segmentDurations[i - 1],
        );
        if (!radio.trackObject.currentSegment.duration) {
          console.warn(`⚠️ | WARN - Segment #${i} duration missing.`);
          radio.trackObject.currentSegment.duration = 28;
        }
        await playSegment(
          radio,
          radio.trackObject.currentSegment,
          currentTrackPosition,
        );
        currentTrackPosition += radio.trackObject.currentSegment.duration;
      } catch (error) {
        console.error(`🔥 | ERROR - Playing segment #${i}: ${error.message}`);
      }
    }
  }

  async function playSegment(radio, segment, trackPosition) {
    console.log(
      `🎵 | ${radio.name} - Playing segment #${radio.trackObject.track.numCurrentSegment}`,
    );
    radio.trackObject.track.numCurrentSegment++;
    const segmentData = await getStorageFile(
      `${radio.trackObject.track.SRC}/Chunk_${radio.trackObject.track.numCurrentSegment}.mp3`,
    );
    radio.trackObject.currentSegment.SRC = segmentData;
    radio.trackObject.currentSegment.position = 0;

    for (let position = 0; position < segment.duration; position++) {
      if (radio._stopCurrent) {
        console.log(`⏹️ | ${radio.name} - Stopping segment playback.`);
        break;
      }
      await cancellableSleep(radio, 1000);
      radio.trackObject.currentSegment.position = position + 1;
      radio.trackObject.track.position = trackPosition + position + 1;
      console.log(
        `${radio.name} - Track Position: ${radio.trackObject.track.position}, Segment Position: ${radio.trackObject.currentSegment.position}`,
      );
    }
  }

  nextTrack(radioStation);
}

//============================================================= EXAMPLE ENDPOINTS

fastify.get("/getAllTrackInformation", function (request, reply) {
  const allTrackInfo = {};
  RadioManager.forEach((radio) => {
    allTrackInfo[radio.name] = radio.trackObject;
  });
  return allTrackInfo;
});

fastify.get("/stations", function (request, reply) {
  try {
    reply.header("Content-Type", "application/json");
    return radioStationsData;
  } catch (err) {
    console.error("🔥 | ERROR - getting stations:", err);
    reply.code(500).send({ error: "Failed to fetch stations" });
  }
});

fastify.get("/getAllTracks", async function (request, reply) {
  try {
    const snapshot = await db.collection("Tracks").get();
    const tracks = [];
    snapshot.forEach((doc) => {
      const data = doc.data() || {};
      tracks.push({
        title: doc.id,
        author: data.author || null,
        duration: data.duration || null,
      });
    });
    reply.header("Content-Type", "application/json");
    return tracks;
  } catch (err) {
    console.error("🔥 | ERROR - fetching Tracks collection:", err);
    reply.code(500).send({ error: "Failed to fetch tracks" });
  }
});

fastify.post("/admin/editTrackList", function (request, reply) {
  const body = request.body || {};
  const stationName = body.stationName;
  const trackList = body.trackList;
  console.log("DEBUG: Received editTrackList request:", body);

  if (!stationName) {
    return reply.code(400).send({ error: "stationName is required" });
  }
  if (!trackList) {
    return reply.code(400).send({ error: "trackList is required" });
  }

  const radio = RadioManager.find((r) => r.name === stationName);
  if (!radio) {
    return reply.code(404).send({ error: "radio station not found" });
  }

  let newList = [];
  if (Array.isArray(trackList)) {
    newList = trackList
      .map((item) => String(item).trim())
      .filter((s) => s.length > 0);
  } else if (typeof trackList === "string") {
    newList = trackList
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } else {
    return reply.code(400).send({
      error:
        "trackList must be an array of strings or a comma-separated string",
    });
  }

  const currentTitle =
    (radio.trackObject &&
      radio.trackObject.track &&
      radio.trackObject.track.title) ||
    null;
  radio.trackList = newList;
  if (currentTitle && newList.length > 0 && newList[0] === currentTitle) {
    radio.trackNum = 0;
    console.log(
      `ℹ️ | ${radio.name} - Updated trackList but keeping current track playing: ${currentTitle}`,
    );
  } else {
    radio.trackNum = -1;
    if (radio._stop) radio._stop();
    if (radio._nextTrack) {
      try {
        radio._nextTrack();
      } catch (e) {
        console.error("Error triggering nextTrack:", e);
      }
    }
  }

  return reply.send({
    success: true,
    station: radio.name,
    trackList: radio.trackList,
  });
});

fastify.get("/getAllTrackPositions", function (request, reply) {
  const allTrackPositions = {};
  RadioManager.forEach((radio) => {
    allTrackPositions[radio.name] = radio.trackObject.track.position;
  });
  return allTrackPositions;
});

fastify.get("/getAllSegmentPositions", function (request, reply) {
  const allSegmentPositions = {};
  RadioManager.forEach((radio) => {
    allSegmentPositions[radio.name] = radio.trackObject.currentSegment.position;
  });
  return allSegmentPositions;
});

//============================================================= MERGED /addTrack (SIMPLIFIED)

fastify.post("/addTrack", async function (request, reply) {
  const trackID = crypto.randomUUID();
  const chunkSize = 0.25 * 1024 * 1024;
  const outputDir = "chunks";

  if (!request.body.downloadURL) {
    return reply.code(400).send({ error: "downloadURL required" });
  }

  const authorResult = await getOrCreateAuthor(request.body.author);
  if (!authorResult) {
    return reply.code(500).send({ error: "Failed to handle author" });
  }

  // Download, chunk, upload, set DB (async version of example)
  https.get(request.body.downloadURL, (response) => {
    if (response.statusCode !== 200) {
      reply.code(500).send({ error: `HTTP ${response.statusCode}` });
      return;
    }
    let currentChunk = 1;
    let chunkData = Buffer.alloc(0);
    let trackChunkDurationArray = [];

    response.on("data", (chunk) => {
      chunkData = Buffer.concat([chunkData, chunk]);
      while (chunkData.length >= chunkSize) {
        const chunkBuffer = chunkData.slice(0, chunkSize);
        chunkData = chunkData.slice(chunkSize);
        const chunkFilename = `chunks/chunk-${currentChunk++}.mp3`;
        fs.mkdirSync(outputDir, { recursive: true });
        fs.writeFileSync(chunkFilename, chunkBuffer);

        // Upload + duration + DB accum
        storage
          .bucket()
          .upload(chunkFilename, {
            destination: `Tracks/${trackID}/Chunk_${currentChunk - 1}.mp3`,
            metadata: { contentType: "audio/mpeg" },
          })
          .then(() => {
            mp3Duration(chunkFilename).then((duration) => {
              trackChunkDurationArray.push(duration);
              fs.unlinkSync(chunkFilename);
              if (trackChunkDurationArray.length === currentChunk - 1) {
                // Final DB write
                setDatabaseFile("Tracks", trackID, {
                  storageReferenceURL: `Tracks/${trackID}`,
                  title: request.body.title,
                  author: request.body.author,
                  duration: request.body.duration,
                  chunksDuration: trackChunkDurationArray,
                  numChunks: currentChunk - 1,
                }).then(() =>
                  addSongToAuthor(authorResult.id, trackID, request.body.title),
                );
              }
            });
          });
      }
    });

    response.on("end", () => {
      // Handle remaining data
      if (chunkData.length > 0) {
        const chunkFilename = `chunks/chunk-${currentChunk++}.mp3`;
        fs.writeFileSync(chunkFilename, chunkData);

        storage
          .bucket()
          .upload(chunkFilename, {
            destination: `Tracks/${trackID}/Chunk_${currentChunk - 1}.mp3`,
            metadata: { contentType: "audio/mpeg" },
          })
          .then(() => {
            mp3Duration(chunkFilename).then((duration) => {
              trackChunkDurationArray.push(duration);
              fs.unlinkSync(chunkFilename);

              // Final DB write after all chunks
              setDatabaseFile("Tracks", trackID, {
                storageReferenceURL: `Tracks/${trackID}`,
                title: request.body.title,
                author: request.body.author,
                duration: request.body.duration,
                chunksDuration: trackChunkDurationArray,
                numChunks: currentChunk - 1,
              }).then(() => {
                addSongToAuthor(authorResult.id, trackID, request.body.title);
                // Clean up source if exists
                deleteStorageFile("Tracks/FreshlyUploadedMP3File", () => {});
                reply.send({
                  success: true,
                  trackID,
                  chunks: currentChunk - 1,
                });
              });
            });
          });
      } else {
        reply.send({ success: true, trackID });
      }
    });
  });

  return reply; // Early return for streaming
});

//============================================================= AUTHOR ENDPOINTS (KEEP)

fastify.get("/getAllAuthors", async (request, reply) => {
  const snapshot = await db.collection("Authors").get();
  const authors = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  return authors;
});

// Run server
fastify.listen(
  { port: process.env.PORT || 3000, host: "0.0.0.0" },
  (err, address) => {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    console.log(`🟢 | Server on ${address}`);
    start();
  },
);
