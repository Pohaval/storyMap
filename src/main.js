import { createApp } from 'vue'
import { setWorkerUrl } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import './style.css'
import App from './App.vue'

setWorkerUrl(workerUrl)
createApp(App).mount('#app')
