// game.js — Palmera Nights, the playable loop. Owns the scene, the player (on foot
// and in cars), the wanted system and police response, the two-mission opening chain,
// the HUD and minimap, and the title / pause flow. Other files build the world
// (city.js), the cars and their AI (vehicles.js), the crowd (people.js), the sound
// (audio.js) and the helpers (util.js); this file wires them together.
'use strict';

(function () {
  // URL params drive only the screenshot/test hook at the bottom of this file
  // (and an optional layout seed); normal play passes none and is unchanged.
  var params = new URLSearchParams(window.location.search);
  var seedParam = parseInt(params.get('seed'), 10);
  var rng = NV.makeRng(isNaN(seedParam) ? 112233 : seedParam);

  // --- Scene -------------------------------------------------------------
  var container = document.getElementById('scene');
  var renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputEncoding = THREE.sRGBEncoding;
  container.appendChild(renderer.domElement);

  var scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8fc3e8);
  scene.fog = new THREE.Fog(0xa9c8e0, 90, 430);
  var camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 900);

  var sun = new THREE.DirectionalLight(0xffe3b3, 0.95);
  sun.position.set(90, 140, 50);
  scene.add(sun);
  scene.add(new THREE.HemisphereLight(0xcfe8ff, 0x8a7a5a, 0.8));

  var world = NV.buildCity(scene);
  world.scene = scene;

  // --- DOM ----------------------------------------------------------------
  var el = {};
  ['startScreen', 'pauseScreen', 'hud', 'healthFill', 'money', 'stars', 'speed',
   'objective', 'prompt', 'toast', 'minimap', 'wantedLabel'].forEach(function (id) {
    el[id] = document.getElementById(id);
  });
  var mapCtx = el.minimap.getContext('2d');

  // --- Player ---------------------------------------------------------------
  var player = {
    mesh: NV.buildHumanoid(0x27324a, 0x1d1d22, 0xe8b98d),
    heading: Math.PI,
    health: 100,
    money: 120,
    mode: 'foot',          // 'foot' or 'car'
    car: null,
    walkPhase: 0,
    bustTimer: 0
  };
  player.mesh.position.set(world.spawn.x, 0, world.spawn.z);
  scene.add(player.mesh);

  // --- Cars -----------------------------------------------------------------
  var allCars = [];
  // The player's own car, parked by the spawn: taking it is never a crime.
  var ownCar = new NV.Car(scene, { x: 6.5, z: 177.6, heading: Math.PI / 2, color: 0x1fa8a0, own: true });
  allCars.push(ownCar);
  // Parked cars along the curbs, waiting to be stolen.
  for (var pi = 0; pi < 10; pi++) {
    var vertical = rng() < 0.5;
    var rc = NV.randPick(rng, NV.CITY.roadCenters);
    var along = NV.randRange(rng, -175, 175);
    var side = rng() < 0.5 ? -7.4 : 7.4;
    var parked = new NV.Car(scene, {
      x: vertical ? rc + side : along,
      z: vertical ? along : rc + side,
      heading: vertical ? (side > 0 ? Math.PI : 0) : (side > 0 ? Math.PI / 2 : -Math.PI / 2),
      color: NV.randPick(rng, CAR_COLORS)
    });
    allCars.push(parked);
  }
  var trafficCars = NV.Traffic.spawn(scene, rng, 8);
  allCars = allCars.concat(trafficCars);
  NV.Peds.spawn(scene, rng, 14);

  // --- Game state -------------------------------------------------------------
  var G = {
    state: 'title',        // title | playing | paused
    time: 0,
    camYaw: Math.PI,
    camPitch: 0.34,
    driveYawOffset: 0,
    wanted: { heat: 0, lastCrime: -99 },
    policeCooldown: 0,
    mission: 0,            // 0 reach garage, 1 deliver a stolen car, 2 free roam
    toastUntil: 0
  };
  var keys = {};
  var OBJECTIVES = [
    'Reach Delgado Auto Works — follow the gold marker',
    'Steal any car and deliver it to the garage apron',
    'Free roam — Palmera is yours. Make money, dodge the PPD'
  ];

  function stars() {
    if (G.wanted.heat <= 0.05) return 0;
    return NV.clamp(Math.ceil(G.wanted.heat), 1, 5);
  }

  function toast(text, seconds) {
    el.toast.textContent = text;
    el.toast.style.opacity = '1';
    G.toastUntil = G.time + (seconds || 3);
  }

  // Crime raises heat; nearby pedestrians panic. Witnessed thefts cost a full star,
  // quiet ones much less; running someone down is the worst everyday crime.
  function commitCrime(kind, pos) {
    var add = { theft: 1.0, theftQuiet: 0.35, hitPed: 2.0, hitCar: 0.6, hitPolice: 1.2 }[kind] || 0.5;
    G.wanted.heat = Math.min(6, G.wanted.heat + add);
    G.wanted.lastCrime = G.time;
    NV.Peds.startleNear(pos, 17);
  }

  function clearPolice() {
    while (NV.Police.cars.length) NV.Police.remove(scene, NV.Police.cars[0]);
  }

  function respawn(point, fine, label) {
    if (player.mode === 'car' && player.car) { player.car.driver = null; player.car = null; }
    player.mode = 'foot';
    player.mesh.visible = true;
    player.mesh.position.set(point.x, 0, point.z);
    player.health = 100;
    player.money = Math.max(0, player.money - fine);
    G.wanted.heat = 0;
    clearPolice();
    toast(label + ' — $' + fine + ' gone. You are back on the street.', 4);
  }

  // --- Input ------------------------------------------------------------------
  document.addEventListener('keydown', function (e) {
    keys[e.code] = true;
    if (e.code === 'Space') e.preventDefault();
    if (e.code === 'KeyM') {
      var muted = NV.Sound.toggleMute();
      toast(muted ? 'Sound off' : 'Sound on', 1.2);
    }
    if (e.code === 'KeyE' && G.state === 'playing') tryInteract();
  });
  document.addEventListener('keyup', function (e) { keys[e.code] = false; });
  document.addEventListener('mousemove', function (e) {
    if (G.state !== 'playing' || document.pointerLockElement !== renderer.domElement) return;
    if (player.mode === 'car') {
      G.driveYawOffset = NV.clamp(G.driveYawOffset - e.movementX * 0.0024, -1.2, 1.2);
    } else {
      G.camYaw -= e.movementX * 0.0026;
    }
    G.camPitch = NV.clamp(G.camPitch + e.movementY * 0.0022, -0.12, 1.05);
  });
  document.addEventListener('pointerlockchange', function () {
    if (document.pointerLockElement !== renderer.domElement && G.state === 'playing') {
      G.state = 'paused';
      el.pauseScreen.style.display = 'flex';
      NV.Sound.engine(false, 0, 0);
      NV.Sound.siren(false, 0);
    }
  });
  function lockAndPlay() {
    NV.Sound.init();
    renderer.domElement.requestPointerLock();
    el.startScreen.style.display = 'none';
    el.pauseScreen.style.display = 'none';
    el.hud.style.display = 'block';
    G.state = 'playing';
  }
  el.startScreen.addEventListener('click', lockAndPlay);
  el.pauseScreen.addEventListener('click', lockAndPlay);
  window.addEventListener('resize', function () {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // --- Interaction: enter / exit cars ------------------------------------------
  function nearestEnterableCar() {
    var p = player.mesh.position, best = null, bestD = 3.8;
    for (var i = 0; i < allCars.length; i++) {
      var car = allCars[i];
      if (car.police || car.driver === 'player') continue;
      if (Math.abs(car.speed) > 1.5) continue;
      var d = NV.dist2(p.x, p.z, car.pos().x, car.pos().z);
      if (d < bestD) { bestD = d; best = car; }
    }
    return best;
  }

  function tryInteract() {
    if (player.mode === 'car') {
      // Step out on the car's right side.
      var car = player.car;
      var f = car.forward();
      player.mesh.position.set(car.pos().x - f.z * 2.0, 0, car.pos().z + f.x * 2.0);
      NV.resolveCircle(player.mesh.position, 0.45, world.colliders);
      player.mesh.visible = true;
      player.heading = car.heading;
      car.driver = null;
      player.car = null;
      player.mode = 'foot';
      NV.Sound.engine(false, 0, 0);
      return;
    }
    var target = nearestEnterableCar();
    if (!target) return;
    if (target.driver === 'traffic') target.driver = null; // driver bails, unseen
    target.driver = 'player';
    player.car = target;
    player.mode = 'car';
    player.mesh.visible = false;
    if (!target.own && !target.stolen) {
      target.stolen = true;
      var witness = NV.Peds.anyWitness(target.pos(), 26);
      commitCrime(witness ? 'theft' : 'theftQuiet', target.pos());
      toast(witness ? 'Grand theft — and somebody saw it.' : 'Grand theft — nobody saw a thing.', 2.5);
    }
  }

  // --- Per-frame updates ---------------------------------------------------------
  function playerPoint() {
    if (player.mode === 'car' && player.car) {
      var cp = player.car.pos();
      return { x: cp.x, z: cp.z };
    }
    var pp = player.mesh.position;
    return { x: pp.x, z: pp.z };
  }

  function updatePlayerOnFoot(dt) {
    var p = player.mesh.position;
    var lx = Math.sin(G.camYaw), lz = Math.cos(G.camYaw);
    var rx = -lz, rz = lx; // right of the camera's look direction
    var mx = 0, mz = 0;
    if (keys.KeyW) { mx += lx; mz += lz; }
    if (keys.KeyS) { mx -= lx; mz -= lz; }
    if (keys.KeyD) { mx += rx; mz += rz; }
    if (keys.KeyA) { mx -= rx; mz -= rz; }
    var len = Math.sqrt(mx * mx + mz * mz);
    var sprint = keys.ShiftLeft || keys.ShiftRight;
    var speed = sprint ? 8.6 : 5.2;
    if (len > 0.01) {
      mx /= len; mz /= len;
      p.x += mx * speed * dt;
      p.z += mz * speed * dt;
      player.heading = NV.angleLerp(player.heading, Math.atan2(mx, mz), dt * 12);
      player.walkPhase += dt * speed * 1.9;
      NV.walkCycle(player.mesh, player.walkPhase, sprint ? 1.3 : 1);
    } else {
      NV.walkCycle(player.mesh, 0, 0);
    }
    NV.resolveCircle(p, 0.45, world.colliders);
    // Cars are solid to walk into.
    for (var i = 0; i < allCars.length; i++) {
      var c = allCars[i].pos();
      var d = NV.dist2(p.x, p.z, c.x, c.z);
      if (d < 2.0 && d > 1e-4) {
        p.x += (p.x - c.x) / d * (2.0 - d);
        p.z += (p.z - c.z) / d * (2.0 - d);
      }
    }
    var lim = NV.CITY.HALF - 1;
    p.x = NV.clamp(p.x, -lim, lim);
    p.z = NV.clamp(p.z, -lim, lim);
    player.mesh.rotation.y = player.heading;
  }

  function updatePlayerDriving(dt) {
    var car = player.car;
    var input = {
      throttle: (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0),
      steer: (keys.KeyA ? 1 : 0) - (keys.KeyD ? 1 : 0),
      brake: !!keys.Space
    };
    var impact = NV.driveCar(car, dt, input, world.colliders);
    if (impact > 9) {
      NV.Sound.thud(NV.clamp(impact / 27, 0, 1));
      if (impact > 15) player.health -= (impact - 15) * 0.7;
    }
    NV.Sound.engine(true, Math.abs(car.speed) / 27, dt);
    G.camYaw = NV.angleLerp(G.camYaw, car.heading, dt * 4.2);
    G.driveYawOffset = NV.lerp(G.driveYawOffset, 0, dt * 0.8);
  }

  function updateCamera(dt) {
    if (G.state === 'title') {
      var a = G.time * 0.07;
      camera.position.set(Math.cos(a) * 120, 55, Math.sin(a) * 120);
      camera.lookAt(0, 0, 0);
      return;
    }
    var target, dist;
    if (player.mode === 'car' && player.car) {
      var cp = player.car.pos();
      target = { x: cp.x, y: 1.4, z: cp.z };
      dist = 10.5;
      var yaw = G.camYaw + G.driveYawOffset;
      var pitch = 0.3;
      camera.position.set(
        target.x - Math.sin(yaw) * Math.cos(pitch) * dist,
        target.y + Math.sin(pitch) * dist + 1.2,
        target.z - Math.cos(yaw) * Math.cos(pitch) * dist
      );
      camera.lookAt(target.x + Math.sin(yaw) * 6, target.y + 0.6, target.z + Math.cos(yaw) * 6);
    } else {
      var pp = player.mesh.position;
      target = { x: pp.x, y: 1.7, z: pp.z };
      dist = 7.6;
      camera.position.set(
        target.x - Math.sin(G.camYaw) * Math.cos(G.camPitch) * dist,
        target.y + Math.sin(G.camPitch) * dist,
        target.z - Math.cos(G.camYaw) * Math.cos(G.camPitch) * dist
      );
      if (camera.position.y < 0.6) camera.position.y = 0.6;
      camera.lookAt(
        target.x + Math.sin(G.camYaw) * 5, target.y + 0.4, target.z + Math.cos(G.camYaw) * 5
      );
    }
  }

  function updateWanted(dt) {
    var st = stars();
    var pt = playerPoint();
    // Decay: once crimes are a few seconds old and no officer is close, heat bleeds off.
    var nearestPolice = 1e9;
    for (var i = 0; i < NV.Police.cars.length; i++) {
      var pp = NV.Police.cars[i].pos();
      nearestPolice = Math.min(nearestPolice, NV.dist2(pp.x, pp.z, pt.x, pt.z));
    }
    if (G.time - G.wanted.lastCrime > 6 && nearestPolice > 55) {
      G.wanted.heat = Math.max(0, G.wanted.heat - dt * 0.11);
    } else if (G.time - G.wanted.lastCrime > 12) {
      G.wanted.heat = Math.max(0, G.wanted.heat - dt * 0.04);
    }
    if (st > 0 && stars() === 0) {
      clearPolice();
      toast('You lost the heat. The PPD gives up — for now.', 3);
    }
    // Keep the police presence matched to the star count.
    G.policeCooldown -= dt;
    if (stars() > NV.Police.cars.length && G.policeCooldown <= 0) {
      NV.Police.spawnOne(scene, world, pt);
      G.policeCooldown = 2.2;
    }
    // Siren volume follows the nearest unit.
    if (NV.Police.cars.length) {
      NV.Sound.siren(true, NV.clamp(1 - nearestPolice / 80, 0, 1) * 0.06);
    } else {
      NV.Sound.siren(false, 0);
    }
    // Busted: an officer on top of a player on foot for a couple of seconds ends it.
    if (player.mode === 'foot' && stars() > 0 && nearestPolice < 3.4) {
      player.bustTimer += dt;
      if (player.bustTimer > 2) {
        player.bustTimer = 0;
        respawn(world.policeStation, Math.min(player.money, 150), 'BUSTED');
      }
    } else {
      player.bustTimer = Math.max(0, player.bustTimer - dt * 2);
    }
  }

  function updateWorld(dt) {
    var pt = playerPoint();
    // Traffic obstacles: the player plus every car (each car ignores itself by geometry).
    var obstacles = [pt];
    for (var i = 0; i < allCars.length; i++) {
      var c = allCars[i].pos();
      obstacles.push({ x: c.x, z: c.z });
    }
    NV.Traffic.update(dt, world, obstacles);
    NV.Police.update(dt, world, pt, G.time);
    NV.Peds.update(dt, world);

    // Pedestrians versus moving cars: only fast cars knock anyone down.
    for (var ci = 0; ci < allCars.length; ci++) {
      var car = allCars[ci];
      if (Math.abs(car.speed) < 5.5) continue;
      for (var pi2 = 0; pi2 < NV.Peds.list.length; pi2++) {
        var ped = NV.Peds.list[pi2];
        var pp = ped.pos();
        if (NV.dist2(pp.x, pp.z, car.pos().x, car.pos().z) < 1.7) {
          if (ped.knockDown()) {
            NV.Sound.thud(0.7);
            if (car.driver === 'player') {
              commitCrime('hitPed', pp);
              toast('You ran someone down. The whole street saw it.', 3);
            }
          }
        }
      }
      // A speeding car also startles walkers it bears down on.
      if (Math.abs(car.speed) > 11) NV.Peds.startleNear(car.pos(), 9);
    }

    // Car-to-car contacts.
    NV.collideCars(allCars.concat(NV.Police.cars), function (a, b, rel) {
      var playerInvolved = a.driver === 'player' || b.driver === 'player';
      if (!playerInvolved) return;
      NV.Sound.thud(NV.clamp(rel / 16, 0.2, 1));
      var other = a.driver === 'player' ? b : a;
      commitCrime(other.police ? 'hitPolice' : 'hitCar', playerPoint());
      if (rel > 11) player.health -= (rel - 11) * 0.8;
    });

    // Police ramming the player.
    if (player.mode === 'car') {
      for (var ri = 0; ri < NV.Police.cars.length; ri++) {
        var pc = NV.Police.cars[ri];
        if (pc.ai.ramCooldown <= 0 &&
            NV.dist2(pc.pos().x, pc.pos().z, pt.x, pt.z) < 3.6 && Math.abs(pc.speed) > 5) {
          pc.ai.ramCooldown = 1.3;
          player.health -= 5;
          NV.Sound.thud(0.6);
        }
      }
    }
  }

  function updateMissions() {
    var pt = playerPoint();
    var g = world.garage;
    var atGarage = NV.dist2(pt.x, pt.z, g.x, g.z) < g.r;
    if (G.mission === 0 && atGarage) {
      G.mission = 1;
      player.money += 250;
      NV.Sound.jingle();
      toast('Delgado: "You made it. Now bring me a car — any car." +$250', 4);
    } else if (G.mission === 1 && atGarage && player.mode === 'car' && player.car && player.car.stolen) {
      G.mission = 2;
      player.money += 400;
      player.car.stolen = false; // the delivered car is Delgado's now; driving it is legal
      NV.Sound.jingle();
      toast('Delgado: "Clean work." +$400 — the city is yours now.', 4);
    }
  }

  // --- HUD & minimap -------------------------------------------------------------
  function updateHUD() {
    el.healthFill.style.width = NV.clamp(player.health, 0, 100) + '%';
    el.healthFill.style.background = player.health > 30 ? '#59c24d' : '#d23b2e';
    el.money.textContent = '$' + Math.floor(player.money);
    var st = stars();
    var s = '';
    for (var i = 0; i < 5; i++) s += i < st ? '★' : '☆';
    el.stars.textContent = s;
    el.stars.style.opacity = st ? '1' : '0.25';
    el.wantedLabel.style.opacity = st ? '1' : '0';
    el.objective.textContent = OBJECTIVES[G.mission];
    el.speed.textContent = (player.mode === 'car' && player.car)
      ? Math.round(Math.abs(player.car.speed) * 3.6) + ' km/h' : '';
    if (G.state === 'playing' && player.mode === 'foot') {
      el.prompt.textContent = nearestEnterableCar() ? 'E — enter car' : '';
    } else {
      el.prompt.textContent = (G.state === 'playing' && player.mode === 'car') ? 'E — exit car' : '';
    }
    if (G.time > G.toastUntil) el.toast.style.opacity = '0';
  }

  function drawMinimap() {
    var S = el.minimap.width, half = S / 2, scale = half / 120; // 120-unit view radius
    var pt = playerPoint();
    var X = function (wx) { return half + (wx - pt.x) * scale; };
    var Z = function (wz) { return half + (wz - pt.z) * scale; };
    mapCtx.fillStyle = '#20262c';
    mapCtx.fillRect(0, 0, S, S);
    // Blocks as faint pavement squares.
    mapCtx.fillStyle = '#39424b';
    for (var i = 0; i < NV.CITY.GRID; i++) {
      for (var j = 0; j < NV.CITY.GRID; j++) {
        var o = NV.blockOrigin(i, j);
        mapCtx.fillRect(X(o.x), Z(o.z), NV.CITY.BLOCK * scale, NV.CITY.BLOCK * scale);
      }
    }
    // Roads.
    mapCtx.fillStyle = '#59636e';
    for (var k = 0; k < NV.CITY.roadCenters.length; k++) {
      var c = NV.CITY.roadCenters[k];
      mapCtx.fillRect(X(c - NV.CITY.ROAD / 2), 0, NV.CITY.ROAD * scale, S);
      mapCtx.fillRect(0, Z(c - NV.CITY.ROAD / 2), S, NV.CITY.ROAD * scale);
    }
    // Mission marker.
    if (G.mission < 2) {
      mapCtx.fillStyle = '#ffd94d';
      mapCtx.beginPath();
      mapCtx.arc(X(world.garage.x), Z(world.garage.z), 5, 0, Math.PI * 2);
      mapCtx.fill();
    }
    // Traffic.
    mapCtx.fillStyle = '#c8ccd2';
    trafficCars.forEach(function (car) {
      mapCtx.fillRect(X(car.pos().x) - 2, Z(car.pos().z) - 2, 4, 4);
    });
    // Police blips blink.
    if (Math.floor(G.time * 2.4) % 2 === 0) {
      mapCtx.fillStyle = '#ff4040';
      NV.Police.cars.forEach(function (car) {
        mapCtx.beginPath();
        mapCtx.arc(X(car.pos().x), Z(car.pos().z), 3.4, 0, Math.PI * 2);
        mapCtx.fill();
      });
    }
    // Player arrow.
    var heading = player.mode === 'car' && player.car ? player.car.heading : player.heading;
    mapCtx.save();
    mapCtx.translate(half, half);
    mapCtx.rotate(headingToMapAngle(heading));
    mapCtx.fillStyle = '#ffffff';
    mapCtx.beginPath();
    mapCtx.moveTo(0, -7);
    mapCtx.lineTo(4.6, 5);
    mapCtx.lineTo(0, 2.4);
    mapCtx.lineTo(-4.6, 5);
    mapCtx.closePath();
    mapCtx.fill();
    mapCtx.restore();
  }
  // World heading: 0 faces +Z (south on the map, +y down). Canvas rotation is
  // clockwise for positive angles with y down, and a drawn arrow points up (-y),
  // so the map rotation for a heading is PI - heading... verified by the four
  // cardinal points: heading 0 (south) must point down: rotate(PI). Heading
  // PI/2 (east, +X) must point right: rotate(PI/2). PI - PI/2 = PI/2. Correct.
  function headingToMapAngle(heading) { return Math.PI - heading; }

  // --- Main loop --------------------------------------------------------------------
  var clock = new THREE.Clock();
  function frame() {
    requestAnimationFrame(frame);
    var dt = Math.min(clock.getDelta(), 0.05);
    if (G.state === 'playing') {
      G.time += dt;
      if (player.mode === 'car') updatePlayerDriving(dt);
      else { updatePlayerOnFoot(dt); NV.Sound.engine(false, 0, dt); }
      updateWorld(dt);
      updateWanted(dt);
      updateMissions();
      if (player.health <= 0) respawn(world.hospital, Math.min(player.money, 100), 'WASTED');
      updateHUD();
      drawMinimap();
    } else if (G.state === 'title') {
      G.time += dt;
      // The city lives behind the title screen.
      NV.Traffic.update(dt, world, []);
      NV.Peds.update(dt, world);
    }
    updateCamera(dt);
    renderer.render(scene, camera);
  }
  // --- Screenshot / automated-test hook -------------------------------------
  // Headless browsers cannot hold pointer lock, so the title screen's click
  // flow cannot start a test run. With ?autostart=1 (or a ?shot scene other
  // than "start") the game starts directly, without pointer lock; keyboard
  // input works as usual and the camera keeps its default follow position.
  // ?shot=<scene> stages the scenes named in shots.json: start (the title
  // orbit, untouched), play (on foot at spawn), drive (in your car on the
  // z=111 road, throttle held by the script) and chase (the same drive with
  // a 3-star wanted level, so the police response is real gameplay).
  var shotScene = params.get('shot');
  if (params.has('autostart') || (shotScene && shotScene !== 'start')) {
    NV.Sound.init();
    el.startScreen.style.display = 'none';
    el.hud.style.display = 'block';
    G.state = 'playing';
    if (shotScene === 'drive' || shotScene === 'chase') {
      ownCar.mesh.position.set(-150, 0, 108.7); // eastbound lane of the z=111 road, city on both sides
      ownCar.heading = Math.PI / 2;
      ownCar.syncMesh();
      ownCar.driver = 'player';
      player.car = ownCar;
      player.mode = 'car';
      player.mesh.visible = false;
      G.camYaw = ownCar.heading;
      keys.KeyW = true; // scripted throttle: the car drives itself east
      if (shotScene === 'chase') {
        G.wanted.heat = 3;
        G.wanted.lastCrime = 0;
      }
    }
  }

  el.objective.textContent = OBJECTIVES[0];
  frame();
})();
