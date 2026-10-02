<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import * as maplibregl from 'maplibre-gl'

const mapContainer = ref(null)
const selectedRegionName = ref('')
let map
let flyTimer
let parallaxFrame
let dimmingFrame
let parallaxCenter
let parallaxEnabled = false
let pointerPosition = { x: 0, y: 0 }
let regionsData
let hoveredRegionId
let overviewCamera
let selectedRegionPropertyId
let activeDimLayer = 'regions-dim'

const REGIONS_URL =
  'https://raw.githubusercontent.com/imsha/russia_geojson_regions_2021/main/ru.json'

const RUSSIA_BOUNDS = new maplibregl.LngLatBounds(
  [19.638889, 39.185278],
  [-168.996944, 78.843056],
).adjustAntiMeridian()

function getFeatureBounds(feature) {
  const coordinates = []

  function collect(value) {
    if (typeof value[0] === 'number') {
      coordinates.push(value)
      return
    }

    value.forEach(collect)
  }

  collect(feature.geometry.coordinates)

  const referenceLongitude = coordinates[0][0]
  const normalized = coordinates.map(([longitude, latitude]) => {
    while (longitude - referenceLongitude > 180) longitude -= 360
    while (longitude - referenceLongitude < -180) longitude += 360
    return [longitude, latitude]
  })

  return normalized.reduce(
    (bounds, coordinate) => bounds.extend(coordinate),
    new maplibregl.LngLatBounds(normalized[0], normalized[0]),
  )
}

function handleParallax(event) {
  if (!parallaxEnabled || !parallaxCenter) return

  const rect = mapContainer.value.getBoundingClientRect()
  pointerPosition = {
    x: (event.clientX - rect.left) / rect.width - 0.5,
    y: (event.clientY - rect.top) / rect.height - 0.5,
  }

  if (parallaxFrame) return

  parallaxFrame = window.requestAnimationFrame(() => {
    parallaxFrame = null
    map.easeTo({
      center: [
        parallaxCenter.lng + pointerPosition.x * 6,
        parallaxCenter.lat,
      ],
      duration: 250,
      easing: (progress) => 1 - Math.pow(1 - progress, 3),
    })
  })
}

function resetParallax() {
  if (!parallaxEnabled || !parallaxCenter) return
  map.easeTo({ center: parallaxCenter, duration: 350 })
}

function animateRegionsDimming(targets, onComplete) {
  window.cancelAnimationFrame(dimmingFrame)

  const startedAt = performance.now()
  const duration = 900
  const animations = Object.entries(targets).map(([layerId, target]) => ({
    layerId,
    target,
    start: Number(map.getPaintProperty(layerId, 'fill-opacity')),
  }))

  function animate(now) {
    const progress = Math.min((now - startedAt) / duration, 1)
    const easedProgress = (1 - Math.cos(Math.PI * progress)) / 2

    for (const { layerId, start, target } of animations) {
      map.setPaintProperty(
        layerId,
        'fill-opacity',
        start + (target - start) * easedProgress,
      )
    }

    if (progress < 1) {
      dimmingFrame = window.requestAnimationFrame(animate)
    } else {
      onComplete?.()
    }
  }

  dimmingFrame = window.requestAnimationFrame(animate)
}

function returnToRussia() {
  selectedRegionName.value = ''
  selectedRegionPropertyId = undefined
  animateRegionsDimming({
    'regions-dim': 0,
    'regions-dim-next': 0,
  })

  map.stop()
  parallaxEnabled = false
  map.once('moveend', () => {
    parallaxCenter = map.getCenter()
    parallaxEnabled = true
  })
  map.flyTo({
    ...overviewCamera,
    duration: 1600,
    easing: (progress) => (1 - Math.cos(Math.PI * progress)) / 2,
    essential: true,
  })
}

async function addRegions() {
  try {
    const response = await fetch(REGIONS_URL)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)

    regionsData = await response.json()
    map.addSource('russia-regions', {
      type: 'geojson',
      data: regionsData,
      generateId: true,
    })

    map.addLayer({
      id: 'regions-fill',
      type: 'fill',
      source: 'russia-regions',
      paint: {
        'fill-color': '#ffffff',
        'fill-opacity': [
          'case',
          ['boolean', ['feature-state', 'hover'], false],
          0.16,
          0.02,
        ],
      },
    })

    map.addLayer({
      id: 'regions-dim',
      type: 'fill',
      source: 'russia-regions',
      paint: {
        'fill-color': '#111827',
        'fill-opacity': 0,
      },
    })

    map.addLayer({
      id: 'regions-dim-next',
      type: 'fill',
      source: 'russia-regions',
      paint: {
        'fill-color': '#111827',
        'fill-opacity': 0,
      },
    })

    map.addLayer({
      id: 'regions-border',
      type: 'line',
      source: 'russia-regions',
      paint: {
        'line-color': 'rgba(255, 255, 255, 0.8)',
        'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.5, 6, 1.5],
      },
    })

    map.on('mousemove', 'regions-fill', (event) => {
      map.getCanvas().style.cursor = 'pointer'
      const featureId = event.features?.[0]?.id
      if (featureId === hoveredRegionId) return

      if (hoveredRegionId !== undefined) {
        map.setFeatureState(
          { source: 'russia-regions', id: hoveredRegionId },
          { hover: false },
        )
      }

      hoveredRegionId = featureId
      if (featureId !== undefined) {
        map.setFeatureState(
          { source: 'russia-regions', id: featureId },
          { hover: true },
        )
      }
    })

    map.on('mouseleave', 'regions-fill', () => {
      map.getCanvas().style.cursor = ''
      if (hoveredRegionId !== undefined) {
        map.setFeatureState(
          { source: 'russia-regions', id: hoveredRegionId },
          { hover: false },
        )
      }
      hoveredRegionId = undefined
    })

    map.on('click', 'regions-fill', (event) => {
      const properties = event.features?.[0]?.properties
      const region = regionsData.features.find(
        (feature) =>
          String(feature.properties.id) === String(properties?.id),
      )

      if (!region) return

      selectedRegionName.value = properties.name

      if (selectedRegionPropertyId === undefined) {
        map.setFilter(activeDimLayer, ['!=', ['get', 'id'], properties.id])
        animateRegionsDimming({ [activeDimLayer]: 0.58 })
      } else if (selectedRegionPropertyId !== properties.id) {
        const nextDimLayer =
          activeDimLayer === 'regions-dim'
            ? 'regions-dim-next'
            : 'regions-dim'

        map.setFilter(nextDimLayer, ['!=', ['get', 'id'], properties.id])
        map.setPaintProperty(nextDimLayer, 'fill-opacity', 0)
        animateRegionsDimming(
          { [activeDimLayer]: 0, [nextDimLayer]: 0.58 },
          () => {
            activeDimLayer = nextDimLayer
          },
        )
      }

      selectedRegionPropertyId = properties.id

      map.stop()
      parallaxEnabled = false
      map.fitBounds(getFeatureBounds(region), {
        padding: 48,
        maxZoom: 6,
        duration: 1600,
        essential: true,
      })
    })
  } catch (error) {
    console.error('Не удалось загрузить границы регионов:', error)
  }
}

onMounted(() => {
  map = new maplibregl.Map({
    container: mapContainer.value,
    style: 'https://demotiles.maplibre.org/style.json',
    center: [105, 62],
    zoom: 1.9,
    boxZoom: false,
    dragPan: false,
    dragRotate: false,
    scrollZoom: false,
    keyboard: false,
    doubleClickZoom: false,
    touchZoomRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    maxPitch: 0,
  })

  map.on('style.load', () => {
    map.setProjection({ type: 'globe' })
    map.setPaintProperty('background', 'background-color', '#a8adb3')

    const camera = map.cameraForBounds(RUSSIA_BOUNDS, { padding: 0 })

    if (!camera) return

    overviewCamera = { ...camera, zoom: camera.zoom + 0.2 }

    map.jumpTo({ ...camera, zoom: camera.zoom - 0.45 })

    for (const layerId of ['coastline', 'countries-boundary', 'geolines']) {
      if (map.getLayer(layerId)) {
        map.setLayoutProperty(layerId, 'visibility', 'none')
      }
    }

    for (const layer of map.getStyle().layers) {
      if (layer.type !== 'symbol') continue

      if (layer.id === 'countries-label') {
        map.setFilter(layer.id, ['==', 'ADM0_A3', 'RUS'])
      } else {
        map.setLayoutProperty(layer.id, 'visibility', 'none')
      }
    }

    map.addLayer({
      id: 'outside-russia',
      type: 'fill',
      source: 'maplibre',
      'source-layer': 'countries',
      filter: ['!=', 'ADM0_A3', 'RUS'],
      paint: {
        'fill-color': '#a8adb3',
        'fill-opacity': 1,
      },
    })

    map.addLayer({
      id: 'russia-border',
      type: 'line',
      source: 'maplibre',
      'source-layer': 'countries',
      filter: ['==', 'ADM0_A3', 'RUS'],
      paint: {
        'line-color': '#ffffff',
        'line-width': 2,
      },
    })

    map.once('idle', () => {
      flyTimer = window.setTimeout(() => {
        map.once('moveend', () => {
          parallaxCenter = map.getCenter()
          parallaxEnabled = true
        })
        map.flyTo({
          ...overviewCamera,
          duration: 2200,
          essential: true,
        })
      }, 300)
    })

    addRegions()
  })
})

onBeforeUnmount(() => {
  window.clearTimeout(flyTimer)
  window.cancelAnimationFrame(parallaxFrame)
  window.cancelAnimationFrame(dimmingFrame)
  map?.remove()
})
</script>

<template>
  <main
    class="map-shell"
    style="background-color: #a8adb38e"
    @mousemove="handleParallax"
    @mouseleave="resetParallax"
  >
    <div ref="mapContainer" class="map" />
    <button
      v-if="selectedRegionName"
      type="button"
      class="overview-button"
      :aria-label="`Вернуться к карте России из региона ${selectedRegionName}`"
      @click.stop="returnToRussia"
    >
      <span aria-hidden="true">←</span>
      Вся Россия
    </button>
  </main>
</template>
