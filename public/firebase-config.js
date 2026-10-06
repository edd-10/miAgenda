// Configuración del proyecto de Firebase (la apiKey web no es secreta)
var firebaseConfig = {
  apiKey: "AIzaSyDSQXG7t0b4NkDyl3MBc0SaA6jr8KThAJ0",
  // Mismo dominio que el hosting: evita el bloqueo de almacenamiento de terceros en Safari/iOS
  authDomain: "miagenda-cf230.web.app",
  projectId: "miagenda-cf230",
  storageBucket: "miagenda-cf230.firebasestorage.app",
  messagingSenderId: "661122625775",
  appId: "1:661122625775:web:17b36b6c251e954fe3eb1a"
};

// Clave pública VAPID para notificaciones push
// (Consola de Firebase > Configuración del proyecto > Cloud Messaging > Certificados push web > Generar par de claves)
var VAPID_KEY = "BHhYKEWjxjHtbSFstaUXoH22Ev_kP-XHTGxQgYQtVPPm3oWXyc0eKBDNPlr7kt7yuK3ftVXajvXbdI_ja-e0FtE";
