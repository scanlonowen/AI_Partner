document.addEventListener('DOMContentLoaded', () => {
    // --- CONFIGURATION ---
    const GRID_SIZE = 10;
    const CELL_SIZE = 50; // Must match .grid-cell width/height in CSS
    const MAX_LOG_ENTRIES = 18; // Maximum number of messages to keep in the log

    const SURFACES = {
        0: { name: 'Concrete', className: 'surface-0', cost: 1.0 },
        1: { name: 'Grass',    className: 'surface-1', cost: 1.25 },
        2: { name: 'Gravel',   className: 'surface-2', cost: 1.5 },
        3: { name: 'Mulch',    className: 'surface-3', cost: 2.0 },
        4: { name: 'Dirt',     className: 'surface-4', cost: 1.75 },
        5: { name: 'Sand',     className: 'surface-5', cost: 2.5 },
    };

    // 2D array representing the world map
    const map = [
        [1, 1, 1, 1, 5, 5, 5, 0, 0, 0],
        [1, 1, 4, 4, 5, 5, 5, 0, 2, 2],
        [1, 4, 4, 4, 4, 5, 0, 0, 2, 2],
        [1, 4, 3, 3, 4, 5, 0, 2, 2, 2],
        [1, 4, 3, 3, 4, 0, 0, 0, 0, 0],
        [1, 1, 1, 1, 0, 0, 5, 5, 5, 5],
        [3, 3, 3, 1, 0, 5, 5, 4, 4, 5],
        [3, 3, 3, 1, 0, 5, 4, 4, 4, 5],
        [2, 2, 1, 1, 0, 5, 5, 4, 1, 1],
        [2, 2, 1, 0, 0, 0, 5, 5, 1, 1],
    ];

    const robot = {
        x: 0, // column
        y: 0, // row
        element: null
    };

    // State for autonomous movement
    let goal = { x: null, y: null };
    let path = [];
    let robotBehavior = {
        baseSpeedMs: 1000, // Default speed (1000ms = 1 second)
        speedModifier: 1.0, // Default modifier
        currentSpeedMs: 1000
    };

    // State for speed ramping
    let speedRampInterval = null;

    // --- DOM ELEMENTS ---
    const gridElement = document.getElementById('simulator-grid');
    const surfaceNameElement = document.getElementById('surface-name');
    const surfaceNumberElement = document.getElementById('surface-number');
    const legendListElement = document.getElementById('legend-list');
    const robotModeElement = document.getElementById('robot-mode');
    const robotSpeedElement = document.getElementById('robot-speed');
    const logTerminalElement = document.getElementById('log-terminal');
    const smoothingStatusElement = document.getElementById('smoothing-status');
    const startButton = document.getElementById('start-button');

    // --- SOCKET.IO SETUP ---
    const socket = io(); // Connect to the server that served this page
    socket.on('connect', () => console.log('Socket.IO connected successfully!'));

    // --- FUNCTIONS ---

    /**
     * Creates the visual grid and the robot element.
     */
    function createGrid() {
        gridElement.innerHTML = ''; // Clear previous grid if any
        gridElement.style.gridTemplateColumns = `repeat(${GRID_SIZE}, ${CELL_SIZE}px)`;
        gridElement.style.gridTemplateRows = `repeat(${GRID_SIZE}, ${CELL_SIZE}px)`;

        for (let row = 0; row < GRID_SIZE; row++) {
            for (let col = 0; col < GRID_SIZE; col++) {
                const cell = document.createElement('div');
                cell.classList.add('grid-cell');
                const surfaceType = map[row][col];
                cell.dataset.x = col; // Store coordinates for easy access
                cell.dataset.y = row;
                cell.classList.add(SURFACES[surfaceType].className);
                gridElement.appendChild(cell);
            }
        }

        // Create and append the robot element
        robot.element = document.createElement('div');
        robot.element.className = 'robot';
        gridElement.appendChild(robot.element);
    }

    /**
     * Populates the legend in the info panel.
     */
    function createLegend() {
        for (const id in SURFACES) {
            const surface = SURFACES[id];
            const li = document.createElement('li');
            
            const colorBox = document.createElement('div');
            colorBox.className = `legend-color-box ${surface.className}`;
            
            const text = document.createTextNode(`${surface.name} (#${id})`);
            
            li.appendChild(colorBox);
            li.appendChild(text);
            legendListElement.appendChild(li);
        }
    }

    /**
     * Updates the robot's visual position and the info panel.
     */
    function updateRobot() {
        // Update visual position
        robot.element.style.left = `${robot.x * CELL_SIZE}px`;
        robot.element.style.top = `${robot.y * CELL_SIZE}px`;

        // Get current surface and update the report
        const currentSurfaceId = map[robot.y][robot.x];
        const currentSurface = SURFACES[currentSurfaceId];

        // Update the UI report
        surfaceNameElement.textContent = currentSurface.name;
        surfaceNumberElement.textContent = `#${currentSurfaceId}`;

        // Send the current surface data to the backend on every move.
        // console.log(`Robot at [${robot.x}, ${robot.y}]. Sending surface ${currentSurfaceId} to backend...`);
        sendSurfaceData(currentSurfaceId);
    }

    /**
     * Sends the surface ID to the Python backend.
     * @param {number} surfaceId The ID of the surface to send.
     */
    async function sendSurfaceData(surfaceId) {
        // Get the current time to measure latency
        const startTime = Date.now();
        // Add the start time as a query parameter to the request
        const endpoint = `/produce/${surfaceId}?startTime=${startTime}`;
        // ----------------------

        try { 
            logEvent(`[TX] Surface #${surfaceId} detected. Sending vibration data...`, 'tx');
            console.log(`Sending POST request to: ${endpoint}`);
            const response = await fetch(endpoint, {
                method: 'POST',
            });
            if (!response.ok) {
                throw new Error(`HTTP error! Status: ${response.status}`);
            }
            const result = await response.json();
            // console.log('Backend response:', result); // Optional: uncomment for debugging
        } catch (error) {
            console.error('Failed to send data to backend:', error);
            logEvent(`[ERROR] Failed to send data: ${error.message}`, 'error');
        }
    }

    /**
     * Adds a new message to the live log terminal.
     * @param {string} message The text to log.
     * @param {string} type The type of log (e.g., 'tx', 'rx', 'act') for styling.
     */
    function logEvent(message, type) {
        const logEntry = document.createElement('p'); // Create the new log <p> element
        logEntry.textContent = message; // Set its text content
        logEntry.className = `log-${type}`; // Apply styling class (e.g., 'log-tx')

        // Add the new log to the top of the terminal
        logTerminalElement.prepend(logEntry);

        // If the number of logs exceeds the max, remove the oldest one (at the bottom)
        while (logTerminalElement.childElementCount > MAX_LOG_ENTRIES) {
            logTerminalElement.removeChild(logTerminalElement.lastElementChild);
        }
    }

    // --- AUTONOMOUS MOVEMENT LOGIC ---

    /**
     * Generates a new random goal, avoiding the robot's current position.
     */
    function generateNewGoal() {
        // Clear previous path visualization
        document.querySelectorAll('.path-cell').forEach(cell => {
            cell.classList.remove('path-cell');
        });

        // Clear previous goal style
        const oldGoalCell = gridElement.querySelector('.goal-cell');
        if (oldGoalCell) {
            oldGoalCell.classList.remove('goal-cell');
        }

        let newX, newY;
        do {
            newX = Math.floor(Math.random() * GRID_SIZE);
            newY = Math.floor(Math.random() * GRID_SIZE);
        } while (newX === robot.x && newY === robot.y);

        goal = { x: newX, y: newY };

        // Apply new goal style
        const newGoalCell = gridElement.querySelector(`[data-x='${goal.x}'][data-y='${goal.y}']`);
        if (newGoalCell) {
            newGoalCell.classList.add('goal-cell');
        }
        logEvent(`[ACT] New goal: [${goal.x}, ${goal.y}]`, 'act');
    }

    /**
     * Draws the calculated path on the grid for visualization.
     * @param {Array} pathArray The array of {x, y} coordinates.
     */
    function drawPath(pathArray) {
        // Clear any old path visualization
        document.querySelectorAll('.path-cell').forEach(cell => {
            cell.classList.remove('path-cell');
        });

        // Draw the new path
        pathArray.forEach(step => {
            const cell = gridElement.querySelector(`[data-x='${step.x}'][data-y='${step.y}']`);
            if (cell) {
                cell.classList.add('path-cell');
            }
        });
    }

    /**
     * Finds the shortest path (in number of steps) using Breadth-First Search (BFS).
     * This algorithm ignores terrain cost.
     * @returns {Array} An array of {x, y} coordinates representing the path.
     */
    function findPathBFS(start, end) {
        const queue = [[start]];
        const visited = new Set([`${start.x},${start.y}`]);

        while (queue.length > 0) {
            const currentPath = queue.shift();
            const lastNode = currentPath[currentPath.length - 1];

            if (lastNode.x === end.x && lastNode.y === end.y) {
                return currentPath.slice(1); // Return path without the starting node
            }

            // Explore neighbors (up, down, left, right)
            const neighbors = [
                { x: lastNode.x, y: lastNode.y - 1 },
                { x: lastNode.x, y: lastNode.y + 1 },
                { x: lastNode.x - 1, y: lastNode.y },
                { x: lastNode.x + 1, y: lastNode.y },
            ];

            for (const neighbor of neighbors) {
                const key = `${neighbor.x},${neighbor.y}`;
                if (
                    neighbor.x >= 0 && neighbor.x < GRID_SIZE &&
                    neighbor.y >= 0 && neighbor.y < GRID_SIZE &&
                    !visited.has(key)
                ) {
                    visited.add(key);
                    const newPath = [...currentPath, neighbor];
                    queue.push(newPath);
                }
            }
        }
        return []; // No path found
    }

    /**
     * Finds the "cheapest" path using the A* algorithm, considering terrain cost.
     * @returns {Array} An array of {x, y} coordinates representing the path.
     */
    function findPathAStar(start, end) {
        // Heuristic function (Manhattan distance)
        const heuristic = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

        // Initialize openSet with the start node
        const openSet = [{ x: start.x, y: start.y, f: heuristic(start, end), g: 0 }];
        
        // Maps to keep track of path and costs
        const cameFrom = new Map();
        const gScore = new Map();
        
        // Initialize gScore for start node
        gScore.set(`${start.x},${start.y}`, 0);

        while (openSet.length > 0) {
            // 1. Find the node in openSet with the lowest f score
            let lowestFIndex = 0;
            for (let i = 1; i < openSet.length; i++) {
                if (openSet[i].f < openSet[lowestFIndex].f) {
                    lowestFIndex = i;
                }
            }

            // 2. Remove current node from openSet
            const current = openSet.splice(lowestFIndex, 1)[0];

            // 3. Check if we reached the goal
            if (current.x === end.x && current.y === end.y) {
                // Reconstruct path
                const totalPath = [];
                let temp = current;
                
                // SAFETY: Prevent infinite loops by checking if we have a parent
                // and ensuring we don't process more steps than grid cells exist.
                let safetyCounter = 0; 
                const maxSteps = GRID_SIZE * GRID_SIZE; 

                while (temp && safetyCounter < maxSteps) {
                    totalPath.unshift({ x: temp.x, y: temp.y });
                    temp = cameFrom.get(`${temp.x},${temp.y}`);
                    
                    // Explicitly stop if we reached the start node to avoid
                    // any potential cycle issues or undefined behavior
                    if (temp && temp.x === start.x && temp.y === start.y) {
                         // We don't add start to path usually, or we can break here
                         break;
                    }
                    safetyCounter++;
                }
                return totalPath; // Return the path
            }

            // 4. Explore neighbors
            const neighbors = [
                { x: current.x, y: current.y - 1 }, // Up
                { x: current.x, y: current.y + 1 }, // Down
                { x: current.x - 1, y: current.y }, // Left
                { x: current.x + 1, y: current.y }, // Right
            ];

            for (const neighbor of neighbors) {
                // Check bounds
                if (neighbor.x >= 0 && neighbor.x < GRID_SIZE && 
                    neighbor.y >= 0 && neighbor.y < GRID_SIZE) {
                    
                    const surfaceId = map[neighbor.y][neighbor.x];
                    const terrainCost = SURFACES[surfaceId].cost;
                    
                    // Current G score is stored in the map (reliable), or use current.g
                    const currentG = gScore.get(`${current.x},${current.y}`);
                    const tentativeGScore = currentG + terrainCost;
                    
                    const neighborKey = `${neighbor.x},${neighbor.y}`;
                    const existingGScore = gScore.has(neighborKey) ? gScore.get(neighborKey) : Infinity;

                    if (tentativeGScore < existingGScore) {
                        // This path to neighbor is better than any previous one. Record it!
                        cameFrom.set(neighborKey, current);
                        gScore.set(neighborKey, tentativeGScore);
                        const fScore = tentativeGScore + heuristic(neighbor, end);

                        // Check if neighbor is already in openSet
                        const existingNodeIndex = openSet.findIndex(n => n.x === neighbor.x && n.y === neighbor.y);

                        if (existingNodeIndex !== -1) {
                            // UPDATE existing node in openSet with new, lower scores
                            openSet[existingNodeIndex].g = tentativeGScore;
                            openSet[existingNodeIndex].f = fScore;
                        } else {
                            // Add new node to openSet
                            openSet.push({ x: neighbor.x, y: neighbor.y, f: fScore, g: tentativeGScore });
                        }
                    }
                }
            }
        }
        return []; // No path found
    }

    /**
     * Main pathfinding function that selects the algorithm and calculates the path.
     */
    function findAndDrawPath() {
        const selectedAlgo = document.querySelector('input[name="path-algo"]:checked').value;
        logEvent(`[ACT] Calculating path with ${selectedAlgo.toUpperCase()}...`, 'act');

        if (selectedAlgo === 'bfs') {
            path = findPathBFS(robot, goal);
        } else { // astar
            path = findPathAStar(robot, goal);
        }

        if (path.length > 0) {
            drawPath(path);
        } else {
            console.error("Could not find a path to the new goal.");
            logEvent('[ERROR] Path to goal not found!', 'error');
        }
    }


    /**
     * Handles incoming action commands from the backend via WebSocket.
     * @param {object} action The action command object.
     */
    function handleRobotAction(action) {
        console.log('Received robot action:', action);

        // This is a CONFIRMED action. Log it and trigger the speed ramp.
        // We no longer update the main prediction UI here, as handleRawPrediction is now responsible for that.
        const newGait = action.gait || 'Default';
        const startTime = action.start_time; // Get the original timestamp
        const latency = startTime ? `(${Date.now() - startTime}ms)` : '';

        logEvent(`[RX] ✅ CONFIRMED: "${newGait}" ${latency}`, 'rx');

        // Get the target speed from the action and trigger the ramp.
        const targetModifier = action.speed_modifier || 1.0;
        rampSpeed(targetModifier);
    }

    /**
     * Handles incoming RAW, unconfirmed predictions from the backend.
     */
    function handleRawPrediction(prediction) {
        const newGait = prediction.gait || 'Default';
        const confidence = prediction.confidence;
        const startTime = prediction.start_time;

        if (confidence !== undefined) {
            const confidenceText = `${(confidence * 100).toFixed(1)}%`;
            // Update the UI with the raw prediction and confidence.
            robotModeElement.textContent = `${newGait} (Confidence: ${confidenceText}%)`;
        
        // Remove the 'loading' class if it's there
        document.getElementById('prediction-status-box').classList.remove('loading');

            const latency = startTime ? `(${Date.now() - startTime}ms)` : '';
            logEvent(`[RX] Prediction: "${newGait}" ${latency}`, 'rx');
        } // No 'else' needed, as we only care about predictions with confidence.

    }

    /**
     * Smoothly transitions the robot's speed to a new target.
     * @param {number} targetModifier The target speed modifier (e.g., 1.0, 1.5, 2.5).
     */
    function rampSpeed(targetModifier) {
        // Stop any existing ramp.
        if (speedRampInterval) {
            clearInterval(speedRampInterval);
        }

        const startModifier = robotBehavior.speedModifier;
        const targetDelayMs = robotBehavior.baseSpeedMs * targetModifier;

        // If we are already at the target, do nothing.
        if (Math.abs(robotBehavior.currentSpeedMs - targetDelayMs) < 1) {
            smoothingStatusElement.textContent = 'Stable';
            smoothingStatusElement.style.color = '#6bc46d'; // Green
            return;
        }

        const rampDuration = 1000; // Ramp over 1 second
        const updateFrequency = 50; // Update 20 times per second
        const totalSteps = rampDuration / updateFrequency;
        const modifierStep = (targetModifier - startModifier) / totalSteps;
        let currentStep = 0;

        logEvent(`[ACT] Ramping speed to match ${targetModifier}x modifier...`, 'act');
        smoothingStatusElement.textContent = 'Ramping Speed...';
        smoothingStatusElement.style.color = '#f9a857'; // Orange

        speedRampInterval = setInterval(() => {
            currentStep++;
            if (currentStep >= totalSteps) {
                // Final step: set directly to the target to avoid floating point errors.
                robotBehavior.speedModifier = targetModifier;
                clearInterval(speedRampInterval);
                speedRampInterval = null;
                smoothingStatusElement.textContent = 'Stable';
                smoothingStatusElement.style.color = '#6bc46d'; // Green
            } else {
                robotBehavior.speedModifier += modifierStep;
            }

            // Update the robot's actual speed and the UI display.
            robotBehavior.currentSpeedMs = robotBehavior.baseSpeedMs * robotBehavior.speedModifier;
            const stepsPerSecond = 1000 / robotBehavior.currentSpeedMs;
            robotSpeedElement.textContent = `${stepsPerSecond.toFixed(2)} steps/sec`;

        }, updateFrequency);
    }

    /**
     * The main loop for the robot's autonomous movement. It moves one step,
     * then schedules the next step based on the current (potentially ramping) speed.
     */
    function autonomousStep() {
        if (robot.x === goal.x && robot.y === goal.y) {
            // If robot is at the goal, generate a new one and find the path
            generateNewGoal();
            findAndDrawPath();
        } else if (path.length > 0) {
            // If there's a path, move to the next step
            const nextStep = path.shift();
            robot.x = nextStep.x;
            robot.y = nextStep.y;
            updateRobot();
        }

        // Always schedule the next step to continue the loop.
        setTimeout(autonomousStep, robotBehavior.currentSpeedMs);
    }

    // --- INITIALIZATION ---
    function init() {
        createGrid();
        createLegend();
        
        // Set initial robot position and UI
        updateRobot(); 

        // Set initial instruction text
        const instructions = document.querySelector('.instructions p');
        if (instructions) {
            instructions.innerHTML = 'Click <strong>Start Robot</strong> to begin autonomous movement.<br><small>Terrain data: Ahmadi, R. et al. (2020).<br>QCAT legged robot terrain classification dataset. v2. CSIRO. <a href="https://doi.org/10.25919/5f88b9c730442" target="_blank" rel="noopener noreferrer">https://doi.org/10.25919/5f88b9c730442</a></small>';
        }

        // Add event listener for algorithm change
        document.querySelectorAll('input[name="path-algo"]').forEach(radio => {
            radio.addEventListener('change', findAndDrawPath);
        });
        
        // Listen for actions from the backend
        socket.on('robot_action', handleRobotAction);
        socket.on('raw_prediction', handleRawPrediction);

        // --- START BUTTON LOGIC ---
        startButton.addEventListener('click', () => {
            // Hide the button and update instructions
            startButton.style.display = 'none';
            if (instructions) {
                instructions.innerHTML = '<strong>Robot is moving autonomously</strong> to the blinking target.<br><small>Terrain data: Ahmadi, R. et al. (2020).<br>QCAT legged robot terrain classification dataset. v2. CSIRO. <a href="https://doi.org/10.25919/5f88b9c730442" target="_blank" rel="noopener noreferrer">https://doi.org/10.25919/5f88b9c730442</a></small>';
            }
            robotModeElement.textContent = 'Awaiting first prediction...';
            document.getElementById('prediction-status-box').classList.add('loading');

            // Start the autonomous behavior
            generateNewGoal();
            findAndDrawPath();
            autonomousStep();
        }, { once: true }); // The button can only be clicked once.
    }

    init();
});
