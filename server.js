require('dotenv').config();
const express = require('express');
const axios = require("axios");
const querystring = require("querystring");
const crypto = require('crypto');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const { bufferToFrame, splitChunks } = require('./epdFrame');
const wss = new WebSocketServer({ port: 8080 });

const app = express();
const PORT = 3000;

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const TOKEN_FILE = './tokens.json';

let access_token = "";
let refresh_token ="";
let lastSong = "";
let lastArtist = "";
let lastCoverUrl = "";     // album cover currently on the display
let lastFrameChunks = null; // cached frame, sent to the ESP32 when it connects
let coverSeq = 0;           // lets the newest cover win if songs change quickly


app.use(express.json());

app.get('/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex')
  const scope = [
    "user-read-playback-state",
    "user-modify-playback-state",
    'user-read-currently-playing',
  ]
  
  res.redirect('https://accounts.spotify.com/authorize?' + 
    querystring.stringify({
      response_type: 'code',
      client_id: CLIENT_ID,
      scope: scope,
      redirect_uri: REDIRECT_URI,
      state: state
    })
  )
})

app.get('/callback', async (req, res) => {
  const code = req.query.code;
  const state = req.query.state;

  try{
    if(state == null){
      res.redirect('/#' + querystring.stringify({
        error: 'state_mismatch'
      }))
    }
    else {
      const tokenRes = await axios.post(
        "https://accounts.spotify.com/api/token",
        new URLSearchParams({
          code: code,
          redirect_uri: REDIRECT_URI,
          grant_type: 'authorization_code'
        }).toString(),{
          headers:{
          'content-type': 'application/x-www-form-urlencoded',
          'Authorization': 'Basic ' + (new Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64'))
          }
        }  
      )
      access_token = tokenRes.data.access_token
      refresh_token = tokenRes.data.refresh_token
      fs.writeFileSync(TOKEN_FILE, JSON.stringify({ access_token, refresh_token }));
      res.send("Spotify login successfull. Close this tab")
    }
  }
  catch (err){
    console.error("token exchange failed: ", err.response?.data || err.message)
    res.send("Auth Failed")
  }
})

app.get('/currently_playing', async (req, res) => {
  try{
      if(!access_token){
      return res.json({song: "None", artist: "None"})
    }
    
    const r = await axios.get(
      "https://api.spotify.com/v1/me/player/currently-playing",
      {
        headers: {
          Authorization: `Bearer ${access_token}`
        }
      }
    )

    const item = r.data?.item;
    broadcastCurrentlyPlaying(item || null);
    if(!item) return res.json({song: "None", artist: "None"});

    res.json({
      song: item.name,
      artist: item.artists.map(a => a.name). join(", ")
    })
  }

  catch (err){
    await getRefreshToken();
    res.json({song: "Refreshing...", artist: ""})
  }
});

app.get('/album_cover', async (req, res) => {
  try{
      if(!access_token){
      return res.json({song: "None", artist: "None"})
    }
    
    const r = await axios.get(
      "https://api.spotify.com/v1/me/player/currently-playing",
      {
        headers: {
          Authorization: `Bearer ${access_token}`
        }
      }
    )
  const item = r.data?.item;
  broadcastCurrentlyPlaying(item || null);
  if(!item) return res.json({song: "None", artist: "None"});
  const imageUrl=item.album?.images?.[0].url;
  if(!imageUrl) return res.send("No album cover available");

  res.writeHead(200, {
    "Content-Type": "text/html"
   });

        res.end(`
            <!DOCTYPE html>
            <html>
            <body>
                <img
                    src="${imageUrl}"
                    alt="Spotify image"
                    style="max-width: 400px;"
                />
            </body>
            </html>
        `);
  }

  catch (err){
    await getRefreshToken();
    res.json({song: "Refreshing...", artist: ""})
  }
});

app.get('/KanyeWest', async (req, res) => {
  const r = await fetch("https://api.spotify.com/v1/artists/5K4W6rqBFWDnAN6FQUkS6x?si=xKpKcpJNQjKI7y9SXQWtJw", {
    headers: {
      Authorization: 'Bearer ' + access_token
    }
  });

  const artistData = await r.json();
  console.log("Artist Name: ", artistData);
  res.status(200).send(artistData.name);
})


wss.on("connection", (ws) => {
  console.log("esp32 Connected")
  ws.send(JSON.stringify({
    message: "Connected to Spotify Server"
  }))
  if (lastFrameChunks) sendFrame(ws, lastFrameChunks)

  ws.on('message', (data) => {
    console.log('recieved from esp32: %s', data);
    ws.send(JSON.stringify({
      reply: `GOT MESSAGE: ${data}`
    }))
  })

  ws.on("close", () => {
    console.log("esp32 disconnected")
  })
})

async function getRefreshToken () {
  try{
    const response = await fetch("https://accounts.spotify.com/api/token", {
      method: 'POST',
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refresh_token,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET
      })
    })
    const data = await response.json()
    access_token = data.access_token
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ access_token, refresh_token }));
    console.log("Refresh Token: " + refresh_token)
  }
  catch(error){
    console.log(error.response?.data || error.message)
  }
}

function broadcastCurrentlyPlaying(item){
  if(!item){
    if(lastSong != "None" || lastArtist != "None"){
      wss.clients.forEach(client => {
        if(client.readyState == client.OPEN){
          client.send(JSON.stringify({ song: "None", artist: "None"}))
        }
      })
      lastSong = "None"
      lastArtist = "None"
      console.log("Broadcasted: None - None")
    }
    return;
  }

  const song = item.name;
  const artist = item.artists.map(a => a.name).join(", ")

  if (song != lastSong || artist != lastArtist){
    wss.clients.forEach(client => {
      if (client.readyState == client.OPEN){
        client.send(JSON.stringify({ song, artist}))
      }
    })
    lastSong = song;
    lastArtist = artist;
    console.log(`Broadcasted: ${artist} - ${song}`)
    updateAlbumCover(item)
  }
}

// ---------- e-paper album cover ----------
// Protocol to the ESP32: text "FRAME", then 6 binary messages of 2500 bytes (= 15000-byte 1-bit frame).
function sendFrame(client, chunks){
  if (client.readyState !== client.OPEN) return;
  client.send("FRAME")
  chunks.forEach(c => client.send(c))
}

async function updateAlbumCover(item){
  const url = item.album?.images?.[0]?.url || item.images?.[0]?.url;   // tracks have album art, podcast episodes have images
  if (!url || url === lastCoverUrl) return;          // same album: no need to refresh the e-paper
  const seq = ++coverSeq;
  try{
    const img = await axios.get(url, { responseType: 'arraybuffer' })
    const frame = await bufferToFrame(img.data)
    if (seq !== coverSeq) return;                    // a newer song arrived while converting
    lastCoverUrl = url
    lastFrameChunks = splitChunks(frame)
    wss.clients.forEach(client => sendFrame(client, lastFrameChunks))
    console.log("Sent album cover to ESP32: " + url)
  }
  catch(err){
    console.log("album cover failed:", err.message)
  }
}

async function startServer() {
  if (fs.existsSync(TOKEN_FILE)) {
    const tokens = JSON.parse(fs.readFileSync(TOKEN_FILE));
    refresh_token = tokens.refresh_token || "";
    
    if (refresh_token) {
      await getRefreshToken();
      console.log("Auto logged in");
    } else {
      console.log("No tokens found, visit /login");
    }
  } else {
    console.log("No tokens found, visit /login");
  }

  app.listen(PORT, () => console.log(`live on http://localhost:${PORT}`));

  setInterval(async () =>{
    try{
        if(!access_token){
        return;
      }
      
      const r = await axios.get(
        "https://api.spotify.com/v1/me/player/currently-playing",
        {
          headers: {
            Authorization: `Bearer ${access_token}`
          }
        }
      )

      const item = r.data?.item;
      broadcastCurrentlyPlaying(item || null);
      if(!item) return;  
    }
    catch(err){
      console.log("REFRESHING...")
      await getRefreshToken();
    }
  }, 3000)
}

startServer();
