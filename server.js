const { Client } = require('ssh2');
const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');

const app = express();
app.use(cors());
app.use(express.json()); // Add this to parse JSON requests

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const RPI_IP = 'raspberrypi.local';  
const USERNAME = 'user1';
const PASSWORD = '1234';
const SCRIPT_PATH = '/home/user1/Desktop/THIRDVISION FILES/new season/MARCH28-USERNAME-WITHCOVER.py';
const PYTHON_INTERPRETER = '/home/user1/Downloads/thirdvenv/bin/python3.11';

let runningProcess = null;
let activeConnection = null;

app.post('/start', (req, res) => {
    const { username } = req.body;  // Get username from frontend
    if (!username) return res.status(400).send('Username is required');

    const conn = new Client();
    conn.on('ready', () => {
        console.log(`Starting detection for ${username}...`);

        // Pass username as an argument to the Python script
        const command = `${PYTHON_INTERPRETER} "${SCRIPT_PATH}" "${username}"`;

        conn.exec(command, (err, stream) => {
            if (err) {
                console.error("Failed to start detection:", err);
                return res.status(500).send('Failed to start detection');
            }

            runningProcess = stream;
            activeConnection = conn;

            stream.on('data', (data) => {
                console.log('OUTPUT:', data.toString());
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(data.toString());
                    }
                });
            });

            stream.stderr.on('data', (data) => {
                console.error('ERROR:', data.toString());
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send('ERROR: ' + data.toString());
                    }
                });
            });

            res.send(`Detection started for ${username}`);
        });
    }).connect({
        host: RPI_IP,
        username: USERNAME,
        password: PASSWORD
    });
});

app.get('/stop', (req, res) => {
    const conn = new Client();
    conn.on('ready', () => {
        console.log("Stopping detection...");
        conn.exec(`pgrep -f "${SCRIPT_PATH}"`, (err, stream) => {
            let pids = "";
            stream.on('data', (data) => {
                pids += data.toString();
            });

            stream.on('close', () => {
                if (pids.trim() === "") {
                    console.log("No running detection found.");
                    return res.send("Detection stopped");
                }
                console.log("Found running detection, stopping now...");

                conn.exec(`pkill -f "${SCRIPT_PATH}"`, (killErr, killStream) => {
                    if (killErr) {
                        console.error("Error stopping detection:", killErr);
                        return res.status(500).send("Failed to stop detection");
                    }

                    killStream.on('close', () => {
                        console.log("Detection successfully stopped.");
                        res.send("Detection stopped");
                        conn.end();
                    });

                    killStream.stderr.on('data', (data) => {
                        console.error('ERROR:', data.toString());
                    });
                });
            });

            stream.stderr.on('data', (data) => {
                console.error('ERROR:', data.toString());
            });
        });
    }).connect({
        host: RPI_IP,
        username: USERNAME,
        password: PASSWORD
    });
});

// ✅ MOVE `/set-wifi` OUTSIDE OF `/stop`
app.post('/set-wifi', express.json(), (req, res) => {
    const { ssid, password } = req.body;
    if (!ssid || !password) return res.status(400).send('Missing WiFi credentials');

    console.log(`Received WiFi Change Request: SSID=${ssid}`);

    const conn = new Client();
    conn.on('ready', () => {
        console.log(`Setting new WiFi: SSID=${ssid}`);

        // Overwrite WiFi settings instead of appending
        const wifiConfig = `
ctrl_interface=DIR=/var/run/wpa_supplicant GROUP=netdev
update_config=1
country=US

network={
    ssid="${ssid}"
    psk="${password}"
    key_mgmt=WPA-PSK
}
        `;

        const command = `
            echo '${wifiConfig}' | sudo tee /etc/wpa_supplicant/wpa_supplicant.conf > /dev/null &&
            sudo wpa_cli -i wlan0 reconfigure &&
            sleep 5 && echo "WiFi Updated"
        `;

        conn.exec(command, (err, stream) => {
            if (err) {
                console.error("WiFi update failed:", err);
                return res.status(500).send('Failed to update WiFi settings');
            }

            let output = "";
            stream.on('data', (data) => {
                output += data.toString();
            });

            stream.on('close', () => {
                console.log(`Backend Response: ${output.trim()}`);
                if (output.includes("FAIL")) {
                    res.status(500).send("WiFi change failed. Check logs.");
                } else {
                    res.send("WiFi settings updated. Reconnecting...");
                }
                conn.end();
            });

            stream.stderr.on('data', (data) => {
                console.error('ERROR:', data.toString());
            });
        });
    }).connect({
        host: RPI_IP,
        username: USERNAME,
        password: PASSWORD
    });
});


// ✅ MOVE `/current-wifi` OUTSIDE OF `/stop`
app.get('/current-wifi', (req, res) => {
    const conn = new Client();
    conn.on('ready', () => {
        console.log("Checking network connection...");

        // Check WiFi (wlan0) first
        conn.exec("/usr/sbin/iwgetid -r", (err, stream) => {
            let wifiSSID = "";
            if (err) console.error("Failed to get WiFi SSID:", err);

            stream.on('data', (data) => {
                wifiSSID = data.toString().trim();
            });

            stream.on('close', () => {
                if (wifiSSID) {
                    console.log(`Connected to WiFi: ${wifiSSID}`);
                    res.send(wifiSSID); // ✅ Return WiFi SSID if available
                    conn.end();
                } else {
                    // If no WiFi, check Ethernet (eth0)
                    conn.exec("ip route get 8.8.8.8 | awk '{print $5}'", (err2, ethStream) => {
                        let ethInterface = "";
                        if (err2) console.error("Failed to get Ethernet status:", err2);

                        ethStream.on('data', (data) => {
                            ethInterface = data.toString().trim();
                        });

                        ethStream.on('close', () => {
                            if (ethInterface.includes("eth0")) {
                                console.log("Connected via Ethernet");
                                res.send("Ethernet Connected"); // ✅ Show Ethernet status
                            } else {
                                console.log("No active connection.");
                                res.send("Not Connected"); // ❌ No network detected
                            }
                            conn.end();
                        });

                        ethStream.stderr.on('data', (data) => {
                            console.error('Ethernet Check ERROR:', data.toString());
                        });
                    });
                }
            });

            stream.stderr.on('data', (data) => {
                console.error('WiFi Check ERROR:', data.toString());
            });
        });
    }).connect({
        host: RPI_IP,
        username: USERNAME,
        password: PASSWORD
    });
});



// ✅ NOW THE ROUTES ARE INDEPENDENT
server.listen(5001, () => console.log('Server running on port 5001'));
