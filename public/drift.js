const canvas = document.getElementsByTagName("canvas")[0];
const ctx = canvas.getContext("2d");
const headerRef = document.getElementsByTagName("header")[0];
const instructionsRef = document.getElementsByClassName("instructions")[0];
const carRef = document.getElementsByClassName("car")[0];
const arrowUpRef = document.getElementsByClassName("arrow-up")[0];
const arrowDownRef = document.getElementsByClassName("arrow-down")[0];
const arrowRightRef = document.getElementsByClassName("arrow-right")[0];
const arrowLeftRef = document.getElementsByClassName("arrow-left")[0];
const mobileControlsRef = document.getElementsByClassName("mobile-controls")[0];
const clearTireMarksRef =
  document.getElementsByClassName("clear-tire-marks")[0];
const carWidth = carRef.offsetWidth;
const carHeight = carRef.offsetHeight;

let hasTouchScreen = false;
let showMobileControls = false;

let hideTitle = false;

// Environmental data
const dragFactor = 0.98;
const frictionFactor = 0.94;

// Variable car data
const car = {
  xPos: window.innerWidth / 2,
  yPos: window.innerHeight / 2,
  xSpeed: 0,
  ySpeed: 0,
  speed: 0,
  driftAngle: 0,
  angle: 0,
  angularVelocity: 0,
  isTurning: false,
  isTurningLeft: false,
  isTurningRight: false,
  isReversing: false,
};

// Constant car data
const carConstants = {
  maxSpeed: 10,
  maxReverseSpeed: -4,
  accelerationFactor: 0.2,
  decelerationFactor: 0.1,
  driftFactor: 0.75,
  turnFactor: 0.15,
};

canvas.width = window.innerWidth;
canvas.height = window.innerHeight;

// Determine if device is mobile
if ("maxTouchPoints" in navigator) {
  hasTouchScreen = navigator.maxTouchPoints > 0;
}

// Display touch controls for mobile
if (hasTouchScreen) {
  instructionsRef.innerHTML = "Use the touch controls to drive!";

  mobileControlsRef.style.display = "flex";

  window.oncontextmenu = (event) => {
    event.preventDefault();
    event.stopPropagation();
    return false;
  };

  arrowUpRef.addEventListener("touchstart", () => {
    controller.ArrowUp.pressed = true;
  });

  arrowUpRef.addEventListener("touchend", () => {
    controller.ArrowUp.pressed = false;
  });

  arrowDownRef.addEventListener("touchstart", () => {
    controller.ArrowDown.pressed = true;
  });

  arrowDownRef.addEventListener("touchend", () => {
    controller.ArrowDown.pressed = false;
  });

  arrowRightRef.addEventListener("touchstart", () => {
    controller.ArrowRight.pressed = true;
  });

  arrowRightRef.addEventListener("touchend", () => {
    controller.ArrowRight.pressed = false;
  });

  arrowLeftRef.addEventListener("touchstart", () => {
    controller.ArrowLeft.pressed = true;
  });

  arrowLeftRef.addEventListener("touchend", () => {
    controller.ArrowLeft.pressed = false;
  });
} else {
  instructionsRef.innerHTML = "Use the arrow keys to drive!";
}

const renderCar = () => {
  // Move and rotate the car (div)
  carRef.style.transform = `translate(${car.xPos}px, ${car.yPos}px) rotate(${
    car.angle + car.driftAngle
  }deg)`;

  // Conditionally render tire marks (when accelerating at low speeds or drifting)
  if (
    (car.speed > 1 && Math.abs(car.driftAngle) > 10) ||
    (controller.ArrowUp.pressed && car.speed < 4) ||
    (controller.ArrowDown.pressed && car.speed > -2)
  ) {
    ctx.fillStyle = "rgba(0, 0, 0, 0.75)";

    // Calculate back tire positions and add a mark
    ctx.fillRect(
      car.xPos -
        Math.cos(
          (Math.PI / 180) * (car.angle + car.driftAngle) + (3 * Math.PI) / 2
        ) *
          10 +
        Math.cos((Math.PI / 180) * (car.angle + car.driftAngle) + Math.PI) * 7 +
        10,
      car.yPos -
        Math.sin(
          (Math.PI / 180) * (car.angle + car.driftAngle) + (3 * Math.PI) / 2
        ) *
          10 +
        Math.sin((Math.PI / 180) * (car.angle + car.driftAngle) + Math.PI) * 7 +
        20,
      2,
      2
    );

    ctx.fillRect(
      car.xPos -
        Math.cos(
          (Math.PI / 180) * (car.angle + car.driftAngle) + (3 * Math.PI) / 2
        ) *
          10 +
        Math.cos((Math.PI / 180) * (car.angle + car.driftAngle) + 2 * Math.PI) *
          7 +
        10,
      car.yPos -
        Math.sin(
          (Math.PI / 180) * (car.angle + car.driftAngle) + (3 * Math.PI) / 2
        ) *
          10 +
        Math.sin((Math.PI / 180) * (car.angle + car.driftAngle) + 2 * Math.PI) *
          7 +
        20,
      2,
      2
    );
  }
};

const accelerate = () => {
  if (car.speed < carConstants.maxSpeed) {
    car.speed += carConstants.accelerationFactor;
  }
};

const decelerate = () => {
  if (car.speed > carConstants.maxReverseSpeed) {
    car.speed -= carConstants.decelerationFactor;
  }
};

const left = () => {
  car.isTurning = true;
  car.angularVelocity -=
    carConstants.turnFactor *
    (controller.ArrowUp.pressed ? 1 : (car.speed / carConstants.maxSpeed) * 2);
};

const right = () => {
  car.isTurning = true;
  car.angularVelocity +=
    carConstants.turnFactor *
    (controller.ArrowUp.pressed ? 1 : (car.speed / carConstants.maxSpeed) * 2);
};

// Controller to allow for simultaneous keypresses
const controller = {
  ArrowUp: { pressed: false, func: accelerate },
  ArrowDown: { pressed: false, func: decelerate },
  ArrowLeft: { pressed: false, func: left },
  ArrowRight: { pressed: false, func: right },
};

document.addEventListener("keydown", (e) => {
  if (Object.keys(controller).includes(e.key)) {
    controller[e.key].pressed = true;
  }
});

document.addEventListener("keyup", (e) => {
  if (Object.keys(controller).includes(e.key)) {
    controller[e.key].pressed = false;
  }
});

clearTireMarksRef.addEventListener("click", () => {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
});

const updateCar = () => {
  Object.keys(controller).forEach((key) => {
    if (controller[key].pressed) {
      controller[key].func();

      if (!hideTitle) {
        headerRef.style.display = "none";
        hideTitle = true;
        clearTireMarksRef.style.display = "block";
      }
    }
  });

  car.isReversing = car.speed >= 0 ? false : true;

  // Apply drag and update speed and angle
  car.angularVelocity *= frictionFactor;
  if (!car.isReversing)
    car.driftAngle += carConstants.driftFactor * car.angularVelocity;
  car.driftAngle *= frictionFactor;
  car.angle += car.angularVelocity;
  car.speed =
    car.speed * dragFactor -
    (car.isReversing ? -1 : 1) *
      ((Math.abs(car.driftAngle) * car.speed) / 1000);

  // Calculate vertical and horizontal speeds
  car.xSpeed =
    Math.sin((Math.PI / 180) * (car.angle - car.driftAngle)) *
    car.speed *
    (car.isTurning ? frictionFactor : 1);
  car.ySpeed =
    Math.cos((Math.PI / 180) * (car.angle - car.driftAngle)) *
    car.speed *
    (car.isTurning ? frictionFactor : 1);

  // Update coordinates and handle driving off the canvas/screen
  car.xPos += car.xSpeed;
  if (car.xPos > canvas.width) {
    car.xPos = 0;
  } else if (car.xPos < 0) {
    car.xPos = canvas.width;
  }

  car.yPos -= car.ySpeed;
  if (car.yPos > canvas.height) {
    car.yPos = 0;
  } else if (car.yPos < 0) {
    car.yPos = canvas.height;
  }

  // Turn direction signalling
  if (car.angularVelocity > 0) {
    car.isTurningRight = true;
    car.isTurningLeft = false;
  } else if (car.angularVelocity < 0) {
    car.isTurningRight = false;
    car.isTurningLeft = true;
  }

  car.isTurning = false;
};

// Animation is tied to refresh rate so we need to force 60 FPS
const throttleAnimationLoop = (func) => {
  let then = new Date().getTime();
  let fps = 60;
  let interval = 1000 / fps;

  return (function loop() {
    let now = new Date().getTime();
    let delta = now - then;

    if (delta > interval) {
      then = now - (delta % interval);
      func();
    }

    requestAnimationFrame(loop);
  })();
};

const animate = () => {
  updateCar();
  renderCar();
};

throttleAnimationLoop(animate);

window.addEventListener("resize", () => {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
});
