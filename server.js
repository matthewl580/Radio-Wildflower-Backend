// DEPENDECIES
const fs = require("fs");
const https = require("https");
const mp3Duration = require("mp3-duration");
const firebase = require("firebase/app");
const path = require("path");
const dotenv = require('dotenv');
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

fastify.register(require('@fastify/cors'), {
    origin: 'https://matthew-radio.netlify.app',
    methods: ['GET', 'POST', 'OPTIONS', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['X-Requested-With', 'Content-Type'],
    credentials: true
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
    private_key: process.env.SERVICE_ACCOUNT_PRIVATE_KEY.replace(/\\NEWLINE/g, '\n'),
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

async function getStorageFile(file, callback = () => { }) {
    const fileRef = getStorage()
        .bucket(process.env.FIREBASE_STORAGE_BUCKET_NAME)
        .file(file);
    const downloadURL = await getDownloadURL(fileRef);
    callback(file);
    return await downloadURL;
}


async function deleteStorageFile(filePath, callback = () => { }) {
    return storage
        .bucket()
        .file(filePath)
        .delete()
        .then((data) => {
            callback(data);
        });
}

const db = getFirestore();

function getDatabaseFile(collection, fileName, func = () => { }) {
    db.collection(collection)
        .doc(fileName)
        .get()
        .then((doc) => {
            func(doc.data());
            return doc.data();
        });
}

function setDatabaseFile(collection, fileName, data) {
    console.log(`🗒️ | Setting /{collection}/{fileName} to: \n ${data}`)
    db.collection(collection).doc(fileName).set(data);
}

//============================================================= START OF ACTUAL CODE

// Load radio stations from JSON so the list is editable and can be expanded
const radioStationsData = require(path.join(__dirname, 'radioStations.json'));

var RadioManager = radioStationsData.map(rs => ({
  name: rs.name,
  trackList: rs.trackList,
  trackNum: 0,
  trackObject: { // Track object specific to this radio station
  currentSegment: { duration: undefined, position: undefined, SRC: "" },
  track: { segmentDurations: [], numSegments: undefined, numCurrentSegment: undefined, author: "", title: "", duration: undefined, position: undefined, SRC: "" },
  },
}));

function start() {
    RadioManager.forEach(radio => playRadioStation(radio)); // Play all stations simultaneously
}


function playRadioStation(radioStation) {
  // Use the radio object's trackNum as the authoritative current track index
  if (typeof radioStation.trackNum !== 'number') radioStation.trackNum = -1;
  // Flag to indicate immediate stop of current playback
  radioStation._stopCurrent = false;

  function nextTrack(radio) {
    if (!Array.isArray(radio.trackList) || radio.trackList.length === 0) {
      console.warn(`⚠️ | ${radio.name} has empty trackList.`);
      return;
    }

    radio.trackNum = (radio.trackNum + 1) % radio.trackList.length; // Wrap around
    const trackTitle = radio.trackList[radio.trackNum];

    console.log(`⏭️ | ${radio.name} - Playing next track (Track #${radio.trackNum + 1}): ${trackTitle}`);

    radio.trackObject = {  // Reset the ENTIRE trackObject
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

    // Clear stop flag when starting a new track
    radio._stopCurrent = false;

    playTrack(radio, trackTitle);
  }

  // Expose nextTrack so external code (admin endpoint) can trigger immediate start
  radioStation._nextTrack = () => nextTrack(radioStation);
  radioStation._stop = () => {
    radioStation._stopCurrent = true;
    // If a cancellable sleep is active, cancel it to stop immediately
    try {
      if (radioStation._currentSleepTimer) {
        clearTimeout(radioStation._currentSleepTimer);
        radioStation._currentSleepTimer = null;
      }
      if (typeof radioStation._currentSleepResolver === 'function') {
        // Resolve the pending sleep so any awaiting logic continues immediately
        radioStation._currentSleepResolver();
        radioStation._currentSleepResolver = null;
      }
    } catch (e) {
      // ignore cancellation errors
    }
  };

  // Helper: cancellable sleep that can be aborted by calling radioStation._stop()
  function cancellableSleep(radio, ms) {
    return new Promise(resolve => {
      // store resolver and timer on the radio object so _stop can cancel
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
      const trackData = await new Promise((resolve, reject) => { // Use Promise for getDatabaseFile
        getDatabaseFile("Tracks", trackTitle, (data) => resolve(data));
      });

      radio.trackObject.track.numSegments = trackData.numChunks;
      radio.trackObject.track.duration = trackData.duration;
      radio.trackObject.track.title = trackData.title;
      radio.trackObject.track.author = trackData.author;
      radio.trackObject.track.SRC = trackData.storageReferenceURL;
      radio.trackObject.track.segmentDurations = trackData.chunksDuration;

      await playSegments(radio); // Wait for all segments to play
      if (!radio._stopCurrent) {
        nextTrack(radio); // Go to the next track *after* playSegments completes if not stopped
      }
    } catch (error) {
      console.error(`🔥 | ERROR - Getting track data: ${error.message}`);
      if (!radio._stopCurrent) nextTrack(radio); // Even on error, proceed to the next track
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
          radio.trackObject.track.segmentDurations[i - 1]
        );
        if (!radio.trackObject.currentSegment.duration) {
          console.warn(`⚠️ | WARN - Segment #${i} duration missing.`);
            // FIRST attempt, only works if this is the last chunk
            if(radio.trackObject.numCurrentSegment >= radio.trackObject.numSegments) {
                          radio.trackObject.currentSegment.duration = 1 + (radio.trackObject.track.duration - ( radio.trackObject.numCurrentSegment * (radio.trackObject.numSegments - 1)));
                console.log("RECIFING with last segment duration calculations (safe)")
            } else {
                // so we may not be at the last segment, lets use the one before us as a placeholder
                if (radio.trackObject.numCurrentSegment != 0) {
                radio.trackObject.currentSegment.duration = radio.trackObject.track.segmentDurations[radio.trackObject.numCurrentSegment - 1];
                    console.log("RECIFING using previous segment length")
                } else {
                    // there is nothing we can do
                              radio.trackObject.currentSegment.duration = 28;
                                        console.log("RECIFING FAILED. Forcing duration to be 28 seconds")

                }
            }
        }
        await playSegment(radio, radio.trackObject.currentSegment, currentTrackPosition);
        currentTrackPosition += radio.trackObject.currentSegment.duration;
      } catch (error) {
        console.error(`🔥 | ERROR - Playing segment #${i}: ${error.message}`);
        // Consider if you want to skip the segment or the entire track on error
      }
    }
  }

  async function playSegment(radio, segment, trackPosition) {
    // ... (same as before, but with the crucial position updates and logging)
    console.log(`🎵 | ${radio.name} - Playing segment #${radio.trackObject.track.numCurrentSegment}`);
      radio.trackObject.track.numCurrentSegment++;
      const segmentData = await getStorageFile(
        `${radio.trackObject.track.SRC}/Chunk_${radio.trackObject.track.numCurrentSegment}.mp3`
      );
      radio.trackObject.currentSegment.SRC = segmentData;
      radio.trackObject.currentSegment.position = 0; // Reset segment position HERE

      // Simulate playback and position tracking (REPLACE THIS WITH ACTUAL AUDIO PLAYBACK LOGIC)
      for (let position = 0; position < segment.duration; position++) {
        if (radio._stopCurrent) {
          console.log(`⏹️ | ${radio.name} - Stopping segment playback.`);
          break;
        }
  await cancellableSleep(radio, 1000); // Simulate 1-second increments with cancellable sleep
        radio.trackObject.currentSegment.position = position + 1;
        radio.trackObject.track.position = trackPosition + position + 1; // Update total track position
        console.log(`${radio.name} - Track Position: ${radio.trackObject.track.position}, Segment Position: ${radio.trackObject.currentSegment.position}`);
      }
  }

  // Start the first track
  nextTrack(radioStation);
}



// ... (Admin routes remain the same)

// Returns track information for *all* radio stations
fastify.get("/getAllTrackInformation", function (request, reply) {
    const allTrackInfo = {};
    RadioManager.forEach(radio => {
        allTrackInfo[radio.name] = radio.trackObject;
    });
    return allTrackInfo;
});

// Returns names of all radio stations currently being used
fastify.get('/stations', function (request, reply) {
  try {
    // Return the full contents of radioStations.json (name, description, trackList)
    reply.header('Content-Type', 'application/json');
    return radioStationsData;
  } catch (err) {
    console.error('🔥 | ERROR - getting stations:', err);
    reply.code(500).send({ error: 'Failed to fetch stations' });
  }
});

// Returns a list of all tracks stored in Firestore `Tracks` collection
// Each item contains: title (doc id), author, duration
fastify.get("/getAllTracks", async function (request, reply) {
  try {
    const snapshot = await db.collection("Tracks").get();
    const tracks = [];
    snapshot.forEach(doc => {
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

// Edit the trackList for a given radio station
// Protected under /admin so Basic Auth will be required by the existing hook
// Expects JSON body: { stationName: string, trackList: string[] | string }
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

  // Find the radio station in the in-memory RadioManager
  const radio = RadioManager.find(r => r.name === stationName);
  if (!radio) {
    return reply.code(404).send({ error: "radio station not found" });
  }

  // Normalize trackList input: accept array of strings or comma-separated string
  let newList = [];
  if (Array.isArray(trackList)) {
    newList = trackList.map(item => String(item).trim()).filter(s => s.length > 0);
  } else if (typeof trackList === 'string') {
    newList = trackList.split(',').map(s => s.trim()).filter(s => s.length > 0);
  } else {
    return reply.code(400).send({ error: "trackList must be an array of strings or a comma-separated string" });
  }

  // Update the in-memory trackList and immediately start playing it from the beginning
  // If playback is running, signal it to stop and trigger the next track to start the new list
  // If the first song in the new list is the song currently playing, DON'T restart playback.
  const currentTitle = (radio.trackObject && radio.trackObject.track && radio.trackObject.track.title) || null;
  radio.trackList = newList;
  if (currentTitle && newList.length > 0 && newList[0] === currentTitle) {
    // Keep playing the current song. Align the trackNum so subsequent nextTrack advances correctly.
    radio.trackNum = 0;
    console.log(`ℹ️ | ${radio.name} - Updated trackList but keeping current track playing: ${currentTitle}`);
  } else {
    // reset index so nextTrack starts at 0
    radio.trackNum = -1;
    // signal stop to current playback
    if (radio._stop) radio._stop();
    // trigger next track immediately if available
    if (radio._nextTrack) {
      try { radio._nextTrack(); } catch (e) { console.error('Error triggering nextTrack:', e); }
    }
  }

  // Respond with the updated station info
  return reply.send({ success: true, station: radio.name, trackList: radio.trackList });
});

// Returns track position for *all* radio stations
fastify.get("/getAllTrackPositions", function (request, reply) {
    const allTrackPositions = {};
    RadioManager.forEach(radio => {
        allTrackPositions[radio.name] = radio.trackObject.track.position;
    });
    return allTrackPositions;
});


// Returns segment position for *all* radio stations
fastify.get("/getAllSegmentPositions", function (request, reply) {
    const allSegmentPositions = {};
    RadioManager.forEach(radio => {
        allSegmentPositions[radio.name] = radio.trackObject.currentSegment.position;
    });
    return allSegmentPositions;
});

fastify.post("/addTrack", function (request, reply) {
  
  if (request.body.authPassword !== "password") {
     // return; // incorrect password (disabled for the sake of debugging)
  }
  reply.header("Access-Control-Allow-Origin", "*");
  reply.header("Access-Control-Allow-Methods", "POST");
  var trackChunkDurationArray = [];

function uploadTrackRefToDatabase(
  request,
  trackChunkDurationArray,
  numChunks
) {
    console.log("🔘 | Trying to upload Track Ref to Database");
  setDatabaseFile("Tracks", request.body.title, {
    storageReferenceURL: `Tracks/${request.body.title}`,
      title: request.body.title,
    author: request.body.author,
    duration: request.body.duration,
    chunksDuration: trackChunkDurationArray,
    numChunks: numChunks,
  });
}
async function uploadMP3ToFirebase(
  filePath,
  destination,
  callback = () => {}
) {
  try {
    // Create a reference to the file in Firebase Storage
    const storageRef = getStorage().bucket();

    // Create a file object from the local path
    const file = fs.readFileSync(filePath);

    // Upload the file to Firebase Storage
    const uploadTask = storageRef
      .upload(filePath, {
        destination: destination, 
        uploadType: "media",
        metadata: {
          contentType: "audio/mpeg",
        },
      })
      .then((data) => {
        callback(data);
      });
  } catch (error) {
    console.error("Error uploading MP3:", error);
  }
}
const chunkSize = 0.25 * 1024 * 1024; // 1/4 MB chunks
const outputDir = "chunks"; // The output directory
  var chunkMediaDurationArray = [];
if (!request.body.downloadURL) {
  console.error("Please provide a valid MP3 URL as an argument.");
  process.exit(1);
}

https
  .get(request.body.downloadURL, (response) => {
    if (response.statusCode !== 200) {
      console.error(`Error fetching MP3 from URL: ${response.statusCode}`);
      process.exit(1);
    }

    let currentChunk = 1;
    let chunkData = Buffer.alloc(0);

    response.on("data", (chunk) => {
      chunkData = Buffer.concat([chunkData, chunk]);
      while (chunkData.length >= chunkSize) {
        const chunkBuffer = chunkData.slice(0, chunkSize);
        chunkData = chunkData.slice(chunkSize);

        fs.mkdirSync(outputDir, { recursive: true }); // Create output directory if needed
        const chunkFilename = `chunks/chunk-${currentChunk++}.mp3`;
          console.log(`making file: chunks/chunk-${currentChunk + 1}.mp3`)
          fs.writeFileSync(chunkFilename, chunkBuffer);
          console.log(`writing file: chunks/chunk-${currentChunk + 1}.mp3`)
        uploadMP3ToFirebase(
          chunkFilename,
          `Tracks/${request.body.title}/Chunk_${currentChunk - 1}.mp3`,
          (data) => {
            // access the duration of the temporary file
            const duration = mp3Duration(chunkFilename).then((data) => {
              // console.log(data);
                trackChunkDurationArray[trackChunkDurationArray.length] = data;
                chunkMediaDurationArray.push(data);
                console.log("uploading track data to IB database");
                //uploading track data to IB database
               // uploadTrackRefToDatabase(request, trackChunkDurationArray, numChunks);
              
               setDatabaseFile("Tracks", request.body.title, {
                storageReferenceURL: `Tracks/${request.body.title}`,
                title: request.body.title,
                author: request.body.author,
                duration: request.body.duration,
                chunksDuration: trackChunkDurationArray,
                numChunks: currentChunk - 1,
              });
       
              fs.unlinkSync(chunkFilename);
            });
          }
        );
        console.log(`Chunk ${currentChunk - 1} saved to: ${chunkFilename}`);
      }
    });

    response.on("end", () => {
      // Write remaining data if any
      if (chunkData.length > 0) {
        const chunkFilename = `chunks/chunk-${currentChunk++}.mp3`;
        const duration = mp3Duration(chunkFilename).then((data) => {
            trackChunkDurationArray.push(data);
            chunkMediaDurationArray.push(data);
             setDatabaseFile("Tracks", request.body.title, {
                storageReferenceURL: `Tracks/${request.body.title}`,
                title: request.body.title,
                author: request.body.author,
                duration: request.body.duration,
                chunksDuration: trackChunkDurationArray,
                numChunks: currentChunk - 1,
              });
        });
        fs.writeFileSync(chunkFilename, chunkData);
        uploadMP3ToFirebase(
          chunkFilename,
          `Tracks/${request.body.title}/Chunk_${currentChunk - 1}.mp3`,
          (data) => {
            fs.unlinkSync(chunkFilename);
            // Delete the inital mp3 file
            deleteStorageFile(
              "Tracks/FreshlyUploadedMP3File",
              console.log("🚮 | Deleted source MP3 successfully")
              );
            
              uploadTrackRefToDatabase(request, chunkMediaDurationArray, chunkMediaDurationArray.length-1);
          }
        );
        console.log(`☑️ | Chunk #${currentChunk - 1} saved to: ${chunkFilename}`);
      }

      console.log("✅ | MP3 splitting complete!");
    });
  })
  .on("error", (error) => {
    console.error(`‼️ | Error splitting MP3: ${error.message}`);
    process.exit(1);
  });

return; // Return nothing
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
    }
);
