let selectedDeviceId = null;
let unityInstance = null;
let video = null;
let canvas = null;
let ctx = null;
let firstFrameSent = false;

let frameLoopId = null;
let detectLoopId = null;

let templates = []; // Stores multiple templates
let matchBuffer = null;
const scale = 0.5;
const templateSize = 100;
const minMatchScore = 0.5;

function RegisterUnityInstance(instance) {
    unityInstance = instance;
    //listCameras();
}

window.RegisterUnityInstance = RegisterUnityInstance;
window.StartFootDetection = StartFootDetection;
window.CaptureFootTemplateFromUnity = CaptureFootTemplateFromUnity;
window.listCameras = listCameras;
window.setupCamera = setupCamera;

async function listCameras() {
    try {
        await navigator.mediaDevices.getUserMedia({ video: true });
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoInputs = devices.filter(d => d.kind === 'videoinput');

        // Try to find the back camera by label
        const backCam = videoInputs.find(d => d.label.toLowerCase().includes("back")) || videoInputs[0];

        if (backCam) {
            await StartFootDetection(backCam.deviceId);

        } else {
            console.error("No camera found.");
        }

    } catch (err) {
        console.error("Camera list error:", err);
    }
}


async function StartFootDetection(deviceId) {
    selectedDeviceId = deviceId;
    firstFrameSent = false;
    cancelLoops();
    await waitForOpenCV();
    console.log("OpenCV Loaded");
    await setupCamera(deviceId);
    // Wait for templates to be captured before starting detection
}

async function setupCamera(deviceId) {
    if (video?.srcObject) {
        video.srcObject.getTracks().forEach(track => track.stop());
        video.srcObject = null;
    }

    if (!video) {
        video = document.createElement("video");
        video.setAttribute("autoplay", "");
        video.setAttribute("playsinline", "");
        video.style.display = "none";
        document.body.appendChild(video);
    }

    const stream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: deviceId } },
        audio: false
    });

    video.srcObject = stream;
    await new Promise(resolve => {
        video.onloadedmetadata = () => video.play().then(resolve).catch(resolve);
    });

    if (!canvas) {
        canvas = document.createElement("canvas");
        canvas.style.display = "none";
        document.body.appendChild(canvas);
        ctx = canvas.getContext("2d");
    }

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    // Show foot highlight box
    const footBox = document.getElementById("footHighlight");
    footBox.style.display = "block";

    // Center the box based on canvas size
    const screenWidth = window.innerWidth;
    const screenHeight = window.innerHeight;

    // Position it in center (same logic as template capture)
    footBox.style.left = `${(screenWidth - templateSize) / 2}px`;
    footBox.style.top = `${(screenHeight - templateSize) / 2}px`;

    if (!firstFrameSent && unityInstance) {
        unityInstance.SendMessage("CameraManager", "OnCameraReady");
        firstFrameSent = true;
    }

    startFrameLoop(); // Start sending frames for UI only
}

function waitForOpenCV() {
    return new Promise(resolve => {
        const check = () => (cv && cv.Mat ? resolve() : setTimeout(check, 100));
        check();
    });
}

function CaptureFootTemplateFromUnity() {
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) return;

    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = video.videoWidth;
    tempCanvas.height = video.videoHeight;
    const tempCtx = tempCanvas.getContext("2d");

    tempCtx.drawImage(video, 0, 0);
    const centerX = Math.floor(video.videoWidth / 2);
    const centerY = Math.floor(video.videoHeight / 2);
    const startX = centerX - templateSize / 2;
    const startY = centerY - templateSize / 2;

    const imageData = tempCtx.getImageData(startX, startY, templateSize, templateSize);
    const newTemplate = cv.matFromImageData(imageData);
    cv.cvtColor(newTemplate, newTemplate, cv.COLOR_RGBA2GRAY);

    const resized = new cv.Mat();
    cv.resize(newTemplate, resized, new cv.Size(0, 0), scale, scale, cv.INTER_AREA);

    templates.push({
        template: newTemplate,
        resizedTemplate: resized
    });

    console.log(`Template ${templates.length} captured.`);

    // Start detection only after capturing two
    if (templates.length === 2) {
        startFootDetectionLoop();
    }
}




function startFrameLoop() {
    function sendFrame() {
        if (!video || video.readyState < 2) {
            frameLoopId = requestAnimationFrame(sendFrame);
            return;
        }

        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        const base64 = canvas.toDataURL("image/jpeg");
        if (unityInstance) {
            unityInstance.SendMessage("CameraManager", "OnReceiveVideoFrame", base64);
            if (!firstFrameSent) {
                unityInstance.SendMessage("CameraManager", "OnCameraReady");
                firstFrameSent = true;
            }
        }

        frameLoopId = requestAnimationFrame(sendFrame);
    }
    sendFrame();
}

function startFootDetectionLoop() {
    function detect() {
        if (templates.length === 0) {
            detectLoopId = requestAnimationFrame(detect);
            return;
        }

        ctx.drawImage(video, 0, 0);
        const frameData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const src = cv.matFromImageData(frameData);
        const gray = new cv.Mat();
        const resized = new cv.Mat();

        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
        cv.GaussianBlur(gray, gray, new cv.Size(3, 3), 0);
        cv.resize(gray, resized, new cv.Size(0, 0), scale, scale, cv.INTER_AREA);

        let bestMatch = { score: 0, pt: null, templateSize: null };

        for (let { resizedTemplate } of templates) {
            const result = new cv.Mat();
            cv.matchTemplate(resized, resizedTemplate, result, cv.TM_CCOEFF_NORMED);
            const minMax = cv.minMaxLoc(result);
            const score = minMax.maxVal;

            if (score > bestMatch.score) {
                bestMatch = {
                    score,
                    pt: minMax.maxLoc,
                    templateSize: resizedTemplate.size()
                };
            }

            result.delete();
        }

        if (bestMatch.score > minMatchScore) {
            const centerX = (bestMatch.pt.x + bestMatch.templateSize.width / 2) / scale;
            const centerY = (bestMatch.pt.y + bestMatch.templateSize.height / 2) / scale;

            const normalized = {
                x: centerX / canvas.width,
                y: centerY / canvas.height
            };

            if (unityInstance) {
                unityInstance.SendMessage("FootCube", "OnReceiveFootPosition", JSON.stringify(normalized));
            }
        }

        src.delete(); gray.delete(); resized.delete();
        detectLoopId = requestAnimationFrame(detect);
    }

    detect();
}


function cancelLoops() {
    if (frameLoopId) cancelAnimationFrame(frameLoopId);
    if (detectLoopId) cancelAnimationFrame(detectLoopId);
    frameLoopId = null;
    detectLoopId = null;
}
