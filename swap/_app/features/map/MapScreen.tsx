// Updated: Added LocationDetails and mobile navigation to match web version - 2023-06-26
// Updated: Improved map control positioning - 2023-06-27
// Updated: Simplified mobile interface removing unnecessary controls - 2024-06-27
// Updated: Fixed satellite view and initial Haiti location - 2024-06-27
// Updated: Fixed to use actual user location - 2024-06-27
// Updated: Fixed cross-platform map implementation - 2024-06-27
// Updated: Switched to WebView+Deck.gl approach for mobile grid - 2024-07-16
// Updated: Switched to Native Tile Overlay approach - 2024-07-16
// Updated: Added zoom level thresholds for grid UrlTile - 2024-07-26
// Updated: Fixed map type comparison for UrlTile - 2024-07-26
// Updated: Removed opacity from UrlTile for debugging - 2024-07-26
// Updated: Fixed followsUserLocation and added fade effects for grid - 2024-07-26
// Updated: Synced minimumZ with server settings - 2024-07-26
// Updated: Modified selection styling and fixed location pin behavior - 2024-07-26
// Updated: Added translucent violet fill with 20% opacity - 2024-07-26
// Updated: Disabled native blue dot in favor of unified custom location indicator - 2024-07-26
// Updated: Added blue dot for location and conditional violet pin for selections - 2024-07-26
// Updated: Fixed ZOOM_THRESHOLDS reference - 2024-07-26
// Updated: Improved user location marker and selection pin - 2024-07-31
// Updated: Using native blue dot and zoom-based pin visibility - 2024-08-01
// Updated: Fixed first click handling on mobile - 2024-08-01
// Updated: Fixed first click cell/pin visibility issue - 2024-08-01
// Updated: Disabled auto-centering on user location - 2024-08-01
// Updated: Matched initial zoom level with web implementation - 2024-08-01
// Updated: Disabled auto-centering on user location - 2024-08-01
// Updated: Fixed active cell visibility and My Location button behavior - 2024-08-01
// Updated: Integrated theme system and added profile navigation - 2024-12-30

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { StyleSheet, View, Platform, Alert, Dimensions, ScaledSize, TouchableOpacity, ActivityIndicator, Text, AppState, SafeAreaView } from 'react-native';
import MapView, { 
  PROVIDER_GOOGLE, 
  MapType, 
  Region, 
  Marker, 
  MarkerPressEvent,
  MapPressEvent,
  Camera,
  UrlTile, // Import UrlTile
  Polygon, // Import Polygon for selected cell
  MAP_TYPES
} from 'react-native-maps';
// import { WebView } from 'react-native-webview'; // REMOVE WebView import
import { StatusBar } from 'expo-status-bar';
import { useNavigation } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import { useMapStore } from '../../store/mapStore';
import { MapLayerType, DEFAULT_CENTER_COORDINATE, DEFAULT_ZOOM_LEVEL, GRID, ZOOM_THRESHOLDS, LOCATION_DOT, PIN } from '../../constants/mapConstants';
import { getCurrentLocation } from '../../services/locationService';
import { useAuthContext } from '../auth/context/AuthContext';
import { useTheme } from '../../theme/ThemeContext';
// Remove gridService imports for now, logic will be in WebView
// import { getVisibleBounds } from '../../services/gridService'; 
import { BoundingBox, Coordinate } from '../../types/map';
// Import necessary functions from gridService for selected cell
import { encodeGeohash, getBoundsOfCell } from '../../services/gridService';

// Import API service and types
import { fetchLocations, Location, LocationQueryParams, searchLocations, SearchAPIResult } from '../../services/MapApiService';
// Import cache service for efficient location caching
import { fetchWithCache, DEFAULT_CACHE_TTL, clearCacheCategory } from '../../utils/cacheService'; 
// Import the updated SearchResult type
import { SearchResult } from '../../types/map';

// Import UI components
import SearchHeader from '../header/SearchHeader';
import LayerToggle from './components/LayerToggle';
import LocationDetails from './components/LocationDetails';
// import GridOverlay from '../components/GridOverlay'; // REMOVE Skia Overlay
import SearchResults from './components/SearchResults';
import { Ionicons } from '@expo/vector-icons';
import Animated, { 
  useSharedValue, 
  useAnimatedStyle, 
  withTiming,
} from 'react-native-reanimated'; // Import Reanimated
import * as Haptics from 'expo-haptics';
import debounce from 'lodash.debounce';
import Geohash from 'latlon-geohash';

// Define navigation types for profile navigation
type RootStackParamList = {
  App: {
    screen: string;
    params?: any;
  };
  ProfileModal: {
    sourceRoute: string;
  };
};

type NavigationProp = StackNavigationProp<RootStackParamList>;

// We still need a default initial region for the map before we get the actual location
// This is just a starting point before the map focuses on the user's actual location
const INITIAL_REGION = {
  latitude: 18.5944, // This will be replaced with user's actual location
  longitude: -72.3074, // This will be replaced with user's actual location
  latitudeDelta: 1, // Wider zoom to show more area initially
  longitudeDelta: 1, // Wider zoom to show more area initially
};

// Define DELTA_THRESHOLD_FOR_GRID using GRID constant
const DELTA_THRESHOLD_FOR_GRID = 0.01; // Keep this threshold, maybe move to constants?
const FADE_DURATION_MS = GRID.FADE_DURATION_MS; // Use duration from constants

// Define a more specific type for the selected location state
interface SelectedLocationState {
  name?: string;      // Optional name from DB location or search result
  geohash: string;     // Geohash (calculated or from DB)
  coordinates: { 
    latitude: number; 
    longitude: number 
  };
  isNearBorder: boolean; // Keep hardcoded for now
  alternatives: Array<{ code: string; distance: number }>; // Keep hardcoded for now
}

// Define a fixed known-good polygon (e.g., a small square in Port-au-Prince)
/*
const FIXED_TEST_POLYGON_COORDS = [
  { latitude: 18.540, longitude: -72.300 },
  { latitude: 18.541, longitude: -72.300 },
  { latitude: 18.541, longitude: -72.299 },
  { latitude: 18.540, longitude: -72.299 },
  { latitude: 18.540, longitude: -72.300 },
];
*/

const MapScreen = () => {
  const mapRef = useRef<MapView>(null);
  // const webViewRef = useRef<WebView>(null); // REMOVE WebView ref
  
  // Navigation and theme
  const navigation = useNavigation<NavigationProp>();
  const { theme } = useTheme();
  
  // Auth context for user data
  const authContext = useAuthContext();
  const user = authContext.user;
  
  // Global map state from store
  const { 
    region, 
    mapType, 
    showGrid, 
    zoomLevel,
    setRegion, 
    setMapType, 
    toggleGrid, 
    setZoomLevel,
    setIsLoading: setStoreLoading
  } = useMapStore();
  
  // Local state
  const [isLoading, setIsLoading] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [currentRegion, setCurrentRegion] = useState<Region | null>(null);
  
  // Add state for locations fetched from API
  const [locations, setLocations] = useState<Location[]>([]); // Restore locations state
  
  // Initialize selectedLocation state with the new type
  const [selectedLocation, setSelectedLocation] = useState<SelectedLocationState>(() => {
    // Calculate initial geohash based on default region
    const initialGeohash = encodeGeohash(INITIAL_REGION.latitude, INITIAL_REGION.longitude, GRID.GEOHASH_PRECISION);
    return {
      name: undefined, // Start with no name
      geohash: initialGeohash, 
      coordinates: { latitude: INITIAL_REGION.latitude, longitude: INITIAL_REGION.longitude },
      isNearBorder: true,
      alternatives: []
    };
  });
  
  // Add new state for search - Updated to match SearchHeader interface
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isSearchActive, setIsSearchActive] = useState<boolean>(false);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  
  // Mock data for demonstration
  const recentSearches: SearchResult[] = [];
  const favorites: { name: string; address: string; count: number; }[] = [];
  
  // Check screen size for mobile view
  const { width } = Dimensions.get('window');
  const isMobile = width < 768;
  
  // Calculate if grid should be shown based on current region delta
  const storeShowGrid = useMapStore(state => state.showGrid);
  const shouldShowGrid = 
      storeShowGrid && 
      region.longitudeDelta != null && 
      region.longitudeDelta < DELTA_THRESHOLD_FOR_GRID;
  
  // State to hold the map camera/view details for sending to WebView
  const [mapRenderState, setMapRenderState] = useState<any>(null);
  const [selectedCoords, setSelectedCoords] = useState<Coordinate | null>(null); // State for selected coords
  const [selectedCellCoords, setSelectedCellCoords] = useState<Coordinate[] | null>(null); // Store coordinates for selected Polygon
  const [firstClickHandled, setFirstClickHandled] = useState(false);

  // Helper function to get user initials for header
  const getHeaderInitials = () => {
    if (user?.firstName && user?.lastName) {
      return `${user.firstName.charAt(0)}${user.lastName.charAt(0)}`.toUpperCase();
    }
    if (user?.firstName) {
      return user.firstName.substring(0, 2).toUpperCase();
    }
    if (user?.email) {
      return user.email.charAt(0).toUpperCase();
    }
    return "U"; 
  };

  // Handle profile navigation
  const handleProfilePress = useCallback(() => {
    console.log('[MapScreen] Profile button pressed, navigating to ProfileModal');
    navigation.navigate('ProfileModal', { sourceRoute: 'Map' });
  }, [navigation]);

  // Tile server URL - now integrated into map backend
  // Using unified map backend for both data and tiles
  const TILE_SERVER_BASE_URL = 'http://192.168.1.110:3004/api/tiles/grid'; // Integrated backend URL

  // State for the tile URL template, updated when map type changes
  const [gridTileUrlTemplate, setGridTileUrlTemplate] = useState<string | null>(null);

  // Function to get the correct grid tile URL based on map type
  const getGridTileUrl = useCallback((currentMapType: MapType) => {
    const mapTypeParam = currentMapType === MAP_TYPES.SATELLITE || currentMapType === MAP_TYPES.HYBRID ? 'satellite' : 'standard';
    const url = `${TILE_SERVER_BASE_URL}/{z}/{x}/{y}.png?mapType=${mapTypeParam}`;
    console.log(`[MapScreen] Using Tile URL Template: ${url}`);
    return url;
  }, []);

  // Update tile URL when map type changes
  useEffect(() => {
    setGridTileUrlTemplate(getGridTileUrl(mapType));
  }, [mapType, getGridTileUrl]);

  // Function to send data to WebView
  const sendDataToWebView = useCallback((type: string, payload: any) => {
    // if (webViewRef.current && isWebViewReady) {
    //   const message = JSON.stringify({ type, payload });
    //   webViewRef.current.postMessage(message);
    // }
  }, []);
  
  // Update map state for WebView on region change
  const handleRegionChange = (newRegion: Region) => {
    // We might still want to update the raw region frequently for other potential uses
    // but we won't calculate zoom level here anymore.
    setCurrentRegion(newRegion);
    // setRegion(newRegion); // Consider if the global store needs frequent updates or only on complete
    console.log('[MapScreen | onRegionChange] Region changing...');
  };
  
  // State to track significant viewport changes
  const [lastLoadedRegion, setLastLoadedRegion] = useState<Region | null>(null);
  
  // Helper to check if viewport change is significant enough to reload
  const isSignificantViewportChange = (newRegion: Region, lastRegion: Region | null): boolean => {
    if (!lastRegion) return true;
    
    // Calculate movement distance in degrees
    const latDiff = Math.abs(newRegion.latitude - lastRegion.latitude);
    const lngDiff = Math.abs(newRegion.longitude - lastRegion.longitude);
    
    // Calculate zoom change
    const zoomDiff = Math.abs(
      Math.log2(360 / newRegion.longitudeDelta) - 
      Math.log2(360 / lastRegion.longitudeDelta)
    );
    
    // Trigger immediate load if:
    // 1. Significant zoom change (>1 zoom level)
    // 2. Moved more than 50% of current viewport
    const significantZoom = zoomDiff > 1;
    const significantPan = latDiff > (newRegion.latitudeDelta * 0.5) || 
                          lngDiff > (newRegion.longitudeDelta * 0.5);
    
    return significantZoom || significantPan;
  };
  
  // Calculate zoom and update global state ONLY when region change is complete
  const handleRegionChangeComplete = (newRegion: Region) => {
    console.log('[MapScreen | onRegionChangeComplete] Change complete.');
    // Update global region state here
    setRegion(newRegion); 
    setCurrentRegion(newRegion); // Also update local currentRegion if needed

    // Calculate and update zoom level from region delta
    if (newRegion.longitudeDelta) {
      // Approximate zoom level calculation
      const newZoomLevel = Math.log2(360 / newRegion.longitudeDelta);
      
      // Check if this is a significant viewport change
      const isSignificant = isSignificantViewportChange(newRegion, lastLoadedRegion);
      
      // Only update if the zoom level actually changed significantly
      if (Math.abs(newZoomLevel - zoomLevel) > 0.01) { 
           console.log(`[MapScreen | onRegionChangeComplete] Zoom level changed from ${zoomLevel} to ${newZoomLevel}`);
           setZoomLevel(newZoomLevel);
           
           if (isSignificant) {
             // Immediate load for significant changes
             console.log('[MapScreen] Significant viewport change - immediate load');
             immediateLoadLocations(newRegion, newZoomLevel);
             setLastLoadedRegion(newRegion);
           } else {
             // Debounced load for minor changes
             debouncedLoadLocations(newRegion, newZoomLevel);
           }
      } else {
           console.log(`[MapScreen | onRegionChangeComplete] Zoom level ${newZoomLevel} very close to previous ${zoomLevel}, not updating.`);
           
           if (isSignificant) {
             // Immediate load for significant pan without zoom change
             console.log('[MapScreen] Significant pan without zoom change - immediate load');
             immediateLoadLocations(newRegion, zoomLevel);
             setLastLoadedRegion(newRegion);
           } else {
             // Debounced load for minor movements
             debouncedLoadLocations(newRegion, zoomLevel);
           }
      }
    } else {
       console.warn('[MapScreen | onRegionChangeComplete] longitudeDelta is missing, cannot calculate zoom.');
    }
  };
  
  // Handle search
  const handleSearch = useCallback(debounce(async (query: string) => {
    setSearchQuery(query);
    if (query.length > 2) { // Only search if query is long enough
      console.log(`[MapScreen] Debounced search triggered for: ${query}`);
      setIsLoading(true);
      try {
        // Call the actual API
        const results = await searchLocations(query);
        console.log('[MapScreen] Search API results:', results);
        // Map API results to the format expected by SearchResults component
        const formattedResults: SearchResult[] = results.map((item: SearchAPIResult) => ({
          id: item.id,
          name: item.name,
          address: item.address || '',
          latitude: item.latitude,
          longitude: item.longitude,
          // category: item.category // Add category if returned by API
        }));
        setSearchResults(formattedResults);
      } catch (error) {
        console.error('[MapScreen] Search API error:', error);
        setSearchResults([]); // Clear results on error
        // Optionally show an error message to the user
        Alert.alert('Search Error', 'Could not perform search.');
      } finally {
        setIsLoading(false);
      }
    } else {
      setSearchResults([]); // Clear results if query is too short
    }
  }, 500), []); // Debounce search input by 500ms
  
  // Handle search activation - Updated for SearchHeader
  const handleSearchPress = useCallback(() => {
    setIsSearchActive(true);
  }, []);
  
  // Handle search cancellation - Updated for SearchHeader
  const handleSearchCancel = useCallback(() => {
    setIsSearchActive(false);
    setSearchQuery("");
  }, []);
  
  // Handle search query changes - Updated for SearchHeader
  const handleSearchQueryChange = useCallback((text: string) => {
    setSearchQuery(text);
    handleSearch(text);
  }, []);
  
  // Handle search result selection
  const handleSearchResultPress = (result: SearchResult) => {
    setIsSearchActive(false);
    if (result.latitude && result.longitude) {
      const coordinates = { latitude: result.latitude, longitude: result.longitude };
      // Calculate geohash for the search result coordinates
      const resultGeohash = encodeGeohash(coordinates.latitude, coordinates.longitude, GRID.GEOHASH_PRECISION);
      
      // Update selected location state correctly
      setSelectedLocation({
        name: result.name, // Use name from search result
        geohash: resultGeohash, // Use calculated geohash
        coordinates: coordinates,
        isNearBorder: true, // TODO: Recalculate
        alternatives: []
      });
      
      // Move map to the selected location
      if (mapRef.current) {
        mapRef.current.animateToRegion({
          ...coordinates,
          latitudeDelta: 0.005, // Zoom in closer
          longitudeDelta: 0.005,
        }, 1000);
      } else {
        console.warn('[MapScreen] Map ref not available for search result');
      }

      // Restore actual cell calculation for search results
      const selectedBounds = getBoundsOfCell(resultGeohash);
      console.log(`[MapScreen | handleSearchResultPress] Calculated bounds: ${JSON.stringify(selectedBounds)}`);

      // Restore REAL cell state updates (NO DELAY)
      if (selectedBounds && typeof selectedBounds.sw[1] === 'number' && typeof selectedBounds.sw[0] === 'number' && typeof selectedBounds.ne[1] === 'number' && typeof selectedBounds.ne[0] === 'number') {
        const coords = [
          { latitude: selectedBounds.sw[1], longitude: selectedBounds.sw[0] },
          { latitude: selectedBounds.ne[1], longitude: selectedBounds.sw[0] },
          { latitude: selectedBounds.ne[1], longitude: selectedBounds.ne[0] },
          { latitude: selectedBounds.sw[1], longitude: selectedBounds.ne[0] },
          { latitude: selectedBounds.sw[1], longitude: selectedBounds.sw[0] } 
        ];
        console.log('[MapScreen | handleSearchResultPress] Setting REAL cell coords:', JSON.stringify(coords));
        setSelectedCellCoords(coords); 
      } else {
        console.warn('[MapScreen | handleSearchResultPress] Could not get bounds for search result geohash:', resultGeohash);
        setSelectedCellCoords(null); 
      }
    } else { 
      console.warn(`[MapScreen] Search result ${result.name} (ID: ${result.id}) missing coordinates.`);
      Alert.alert('Location Missing', 'Coordinates not available for this search result.');
     }
  };
  
  // Move to user's current location
  const moveToCurrentLocation = async () => {
    try {
      console.log('[MapScreen] Moving to current location...');
      setIsLoading(true);
      setStoreLoading(true);
      
      // Get current location
      const location = await getCurrentLocation();
      console.log('[MapScreen] Location retrieved:', location);
      
      // Calculate geohash for the actual current location
      const { latitude, longitude } = location.coordinate;
      const currentGeohash = encodeGeohash(latitude, longitude, GRID.GEOHASH_PRECISION);
      console.log(`[MapScreen | moveToCurrent] User location geohash: ${currentGeohash}`);

      // Update selected location state with current location data
      setSelectedLocation({
        name: undefined, // No name initially for current location
        geohash: currentGeohash, 
        coordinates: { latitude, longitude },
        isNearBorder: true, // TODO: Recalculate based on current location
        alternatives: [] // Reset alternatives
      });

      // --- ADDED: Update map selection state --- 
      const currentBounds = getBoundsOfCell(currentGeohash);
      if (currentBounds) {
        const coords = [
            { latitude: currentBounds.sw[1], longitude: currentBounds.sw[0] },
            { latitude: currentBounds.ne[1], longitude: currentBounds.sw[0] },
            { latitude: currentBounds.ne[1], longitude: currentBounds.ne[0] },
            { latitude: currentBounds.sw[1], longitude: currentBounds.ne[0] },
            { latitude: currentBounds.sw[1], longitude: currentBounds.sw[0] }
        ];
        console.log('[MapScreen | moveToCurrent] Setting cell for current location');
        setSelectedCellCoords(coords);
      } else {
        console.warn('[MapScreen | moveToCurrent] Could not get bounds for current location geohash');
        setSelectedCellCoords(null);
      }
      console.log('[MapScreen | moveToCurrent] Hiding selection pin');
      setSelectionCoords(null); // Hide violet pin
      setSelectionPinVisible(false);
      // if (!firstClickHandled) setFirstClickHandled(true); // Keep firstClickHandled update disabled here, it's handled in map press
      // --- END ADDED --- 
      
      if (mapRef.current) {
        // Use the same zoom level as web for consistency
        const zoomDelta = 360 / Math.pow(2, ZOOM_THRESHOLDS.GRID_FADE_IN + 0.2);
        
        mapRef.current.animateToRegion({
          latitude: location.coordinate.latitude,
          longitude: location.coordinate.longitude,
          latitudeDelta: zoomDelta,
          longitudeDelta: zoomDelta,
        }, 1000);
        
        console.log('[MapScreen] Map animated to current position with web-matched zoom level');
      } else {
        console.warn('[MapScreen] mapRef is null, cannot animate');
      }
    } catch (error) {
      console.error('[MapScreen] Location error:', error);
      
      // Show more detailed error message
      let errorMsg = 'Unable to get your location.';
      if (error instanceof Error) {
        errorMsg = `${errorMsg} ${error.message}`;
      }
      
      Alert.alert(
        'Location Error',
        errorMsg,
        [
          { 
            text: 'Open Settings', 
            onPress: () => {
              // This would open device settings on a real implementation
              console.log('User directed to settings');
            }
          },
          { text: 'Cancel', style: 'cancel' }
        ]
      );
    } finally {
      setIsLoading(false);
      setStoreLoading(false);
    }
  };
  
  // Toggle between standard and satellite map types
  const toggleMapType = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const newMapType = mapType === MAP_TYPES.STANDARD ? MAP_TYPES.SATELLITE : MAP_TYPES.STANDARD;
    setMapType(newMapType);
    console.log(`[MapScreen] Toggling map type to ${newMapType}`);
    // No need to explicitly setGridTileUrlTemplate here,
    // the useEffect watching mapType will handle it.
  };
  
  // Add state to track if selection pin should be visible
  const [selectionPinVisible, setSelectionPinVisible] = useState<boolean>(false);
  const [selectionCoords, setSelectionCoords] = useState<Coordinate | null>(null);
    
  // Watch zoom level to determine if selection pin should be visible
  useEffect(() => {
    const showPin = zoomLevel < ZOOM_THRESHOLDS.PIN_VISIBILITY;
    console.log(`[MapScreen | useEffect zoom] Zoom changed to ${zoomLevel}, PIN_VISIBILITY: ${ZOOM_THRESHOLDS.PIN_VISIBILITY}, Show pin: ${showPin}`);
    setSelectionPinVisible(showPin);
  }, [zoomLevel]); // Keep only zoomLevel as dependency for pin visibility
  
  // Handle map press
  const handleMapPress = (event: MapPressEvent) => {
    try { 
      console.log('[MapScreen | handleMapPress] Entering');
      if (!event || !event.nativeEvent || !event.nativeEvent.coordinate) {
        console.error('[MapScreen | handleMapPress] Invalid map press event received:', event);
        return;
      }
      const { coordinate } = event.nativeEvent;
      console.log('[MapScreen | handleMapPress] Map Press Coordinates:', coordinate);
      if (typeof coordinate.latitude !== 'number' || typeof coordinate.longitude !== 'number') {
        console.error('[MapScreen | handleMapPress] Invalid coordinates in map press event:', coordinate);
        return;
      }
      
      const calculatedGeohash = encodeGeohash(coordinate.latitude, coordinate.longitude, GRID.GEOHASH_PRECISION);
      console.log(`[MapScreen | handleMapPress] Geohash: ${calculatedGeohash}, Zoom: ${zoomLevel}`);
      setSelectionCoords(coordinate);
      
      // REMOVE the zoom guard - always try to set the cell
      const selectedBounds = getBoundsOfCell(calculatedGeohash);
      console.log(`[MapScreen | handleMapPress] Bounds: ${JSON.stringify(selectedBounds)}`);
      if (selectedBounds && typeof selectedBounds.sw[1] === 'number' && typeof selectedBounds.sw[0] === 'number' && typeof selectedBounds.ne[1] === 'number' && typeof selectedBounds.ne[0] === 'number') {
        const coords = [
          { latitude: selectedBounds.sw[1], longitude: selectedBounds.sw[0] },
          { latitude: selectedBounds.ne[1], longitude: selectedBounds.sw[0] },
          { latitude: selectedBounds.ne[1], longitude: selectedBounds.ne[0] },
          { latitude: selectedBounds.sw[1], longitude: selectedBounds.ne[0] },
          { latitude: selectedBounds.sw[1], longitude: selectedBounds.sw[0] } 
        ];
        console.log('[MapScreen | handleMapPress] Setting REAL cell coords:', JSON.stringify(coords));
        setSelectedCellCoords(coords);
      } else {
        console.warn('[MapScreen | handleMapPress] Invalid bounds, clearing cell coords', calculatedGeohash);
        setSelectedCellCoords(null);
      }

      setSelectedLocation({
        name: undefined, 
        geohash: calculatedGeohash, 
        coordinates: coordinate,
        isNearBorder: true, 
        alternatives: [] 
      });
      const showPin = zoomLevel < ZOOM_THRESHOLDS.PIN_VISIBILITY;
      setSelectionPinVisible(showPin);
      if (!firstClickHandled) {
        setFirstClickHandled(true);
      }
      console.log('[MapScreen | handleMapPress] Exiting successfully (All states updated)');
    } catch (error) {
      console.error('[MapScreen | handleMapPress] CRITICAL ERROR:', error);
      if (error instanceof Error) {
          console.error(`[MapScreen | handleMapPress] Error details: ${error.message} ${error.stack}`);
      }
    }
  };
  
  // Reset selection state when region changes significantly
  /* // Keep this commented out unless needed later for edge cases
  useEffect(() => {
    if (firstClickHandled && selectionCoords && selectedCellCoords) {
      console.log('[MapScreen] First click already handled, selection state is ready');
    }
  }, [firstClickHandled, selectionCoords, selectedCellCoords]);
  */
  
  // Add error state for the map
  const [mapError, setMapError] = useState<string | null>(null);
  
  // Handle map error with callback
  const handleError = useCallback(() => {
    console.error('[MapScreen] Map failed to load');
    setMapError('Failed to load map provider');
    setIsLoading(false);
    setStoreLoading(false);
  }, []);
  
  // Handle map ready state
  const handleMapReady = () => {
    console.log('[MapScreen] MapView ready, setting initial state');
    setMapReady(true);
    
    if (INITIAL_REGION) { 
        setCurrentRegion(INITIAL_REGION); 
    }
    
    // Initialize zoom level when map is ready
    console.log(`[MapScreen] Setting initial zoom level: ${DEFAULT_ZOOM_LEVEL}`);
    setZoomLevel(DEFAULT_ZOOM_LEVEL);
    
    // Force initial state for selection-related props
    setSelectionPinVisible(DEFAULT_ZOOM_LEVEL < ZOOM_THRESHOLDS.PIN_VISIBILITY);
    
    setIsLoading(false);
    setStoreLoading(false);
    
    // Fetch locations from backend once map is ready
    loadLocations();
  };

  const handleWebViewLoad = () => {
    console.log('[MapScreen] WebView loaded.');
    // We now wait for 'webviewReady' message before setting isWebViewReady
  };
  
  // Handle messages FROM WebView
  const handleWebViewMessage = (event: any) => {
       try {
         const messageData = JSON.parse(event.nativeEvent.data);
         if (messageData.type === 'webviewReady') {
           console.log('[MapScreen] Received webviewReady message.');
           // setIsWebViewReady(true);
           // Send initial state now that WebView is listening
           if(mapRef.current) {
               // Use getCamera/getMapBoundaries directly for initial state
               Promise.all([mapRef.current.getCamera(), mapRef.current.getMapBoundaries()])
                .then(([camera, bounds]) => {
                    const initialRegion = { // Reconstruct region approx
                       latitude: camera.center.latitude,
                       longitude: camera.center.longitude,
                       latitudeDelta: 0.005, // Use a default reasonable delta
                       longitudeDelta: 0.005
                    };
                    handleRegionChange(initialRegion); // Trigger initial state calc/send
                })
                .catch(err => console.error("Error getting initial map state:", err));
           }
         }
         // Handle other messages...
       } catch (e) {
         console.warn('[MapScreen] Error parsing message from WebView:', e);
       }
  };
  
  // Function to load locations based on current viewport with smart caching
  const loadLocationsForViewport = async (viewportRegion?: Region, currentZoom?: number) => {
    const regionToUse = viewportRegion || region || currentRegion;
    const zoomToUse = currentZoom || zoomLevel;
    
    if (!regionToUse) {
      console.warn('[MapScreen] No region available for loading locations');
      return;
    }

    // Calculate viewport bounds
    const swLat = regionToUse.latitude - regionToUse.latitudeDelta / 2;
    const neLat = regionToUse.latitude + regionToUse.latitudeDelta / 2;
    const swLng = regionToUse.longitude - regionToUse.longitudeDelta / 2;
    const neLng = regionToUse.longitude + regionToUse.longitudeDelta / 2;
    
    const bounds = `${swLat.toFixed(4)},${swLng.toFixed(4)},${neLat.toFixed(4)},${neLng.toFixed(4)}`;
    
    // Create cache key for this viewport
    const cacheKey = `map-locations-${bounds}-z${Math.round(zoomToUse)}`;
    
    console.log('[MapScreen] Loading locations for viewport:', regionToUse, 'zoom:', zoomToUse);
    setIsLoading(true);
    
    try {
      const params: LocationQueryParams = {
        bounds,
        zoom: zoomToUse,
        // Add a buffer to limit for edge cases
        limit: Math.min(2000, Math.max(100, Math.round(zoomToUse * 100)))
      };
      
      // Use cache service with smart TTL based on zoom level
      const cacheTTL = zoomToUse >= 15 
        ? DEFAULT_CACHE_TTL.MAP_LOCATIONS_HIGH_ZOOM  // 2.5 minutes for high zoom (more dynamic)
        : DEFAULT_CACHE_TTL.MAP_LOCATIONS_LOW_ZOOM;  // 10 minutes for low zoom (more stable)
      
      console.log('[MapScreen] Fetching locations with viewport params:', params);
      
      // Use fetchWithCache for intelligent caching and duplicate request prevention
      const fetchedLocations = await fetchWithCache<Location[]>(
        cacheKey,
        () => fetchLocations(params),
        cacheTTL,
        false, // Don't force refresh unless explicitly needed
        'map' // Feature name for cache management
      );
      
      console.log(`[MapScreen] Successfully fetched ${fetchedLocations.length} locations for viewport`);
      setLocations(fetchedLocations);
    } catch (error) {
      console.error('[MapScreen] Failed to fetch locations for viewport:', error);
      // Don't show alert for viewport updates, just log the error
    } finally {
      setIsLoading(false);
    }
  };

  // Backward compatibility function for initial load
  const loadLocations = async () => {
    console.log('[MapScreen] Initial location load...');
    await loadLocationsForViewport();
  };

  // Function to refresh map data (clear cache and reload)
  const refreshMapData = async () => {
    console.log('[MapScreen] Refreshing map data - clearing cache');
    await clearCacheCategory('map-locations');
    await loadLocationsForViewport();
  };

  // Immediate and debounced loading for smooth UX
  const immediateLoadLocations = useCallback((newRegion: Region, newZoomLevel: number) => {
    console.log('[MapScreen] Immediate viewport load triggered');
    loadLocationsForViewport(newRegion, newZoomLevel);
  }, [loadLocationsForViewport]);

  // Fast debounced function for minor movements
  const debouncedLoadLocations = useCallback(
    debounce((newRegion: Region, newZoomLevel: number) => {
      console.log('[MapScreen] Debounced viewport load triggered');
      loadLocationsForViewport(newRegion, newZoomLevel);
    }, 300), // Reduced to 300ms for faster response
    [loadLocationsForViewport]
  );
  
  // Initial setup: focus on user's actual location
  useEffect(() => {
    console.log('[MapScreen] App started, getting user location and loading initial data');
    moveToCurrentLocation();
    // loadLocations() is called in handleMapReady to ensure map is available
  }, []);

  // Determine mapType and construct URL (Log for verification)
  const tileUrlTemplate = `http://192.168.1.110:8080/tiles/grid/{z}/{x}/{y}.png?mapType=${mapType}`;
  console.log("[MapScreen] Using Tile URL Template:", tileUrlTemplate); // Log the URL
  
  // Handle location marker press
  const handleLocationMarkerPress = (location: Location) => {
    try { 
      console.log('[MapScreen | handleLocationMarkerPress] Entering for:', location?.id);
      
      if (!location || typeof location.latitude !== 'number' || typeof location.longitude !== 'number') {
        console.error('[MapScreen | handleLocationMarkerPress] Invalid location data passed', location);
        return;
      }

      const locationGeohash = location.geohash || encodeGeohash(location.latitude, location.longitude, GRID.GEOHASH_PRECISION);
      console.log(`[MapScreen | handleLocationMarkerPress] Geohash: ${locationGeohash}, Zoom: ${zoomLevel}`);
      
      // REMOVE the zoom guard - always try to set the cell
      const selectedBounds = getBoundsOfCell(locationGeohash);
      console.log(`[MapScreen | handleLocationMarkerPress] Calculated bounds: ${JSON.stringify(selectedBounds)}`);

      // Restore ALL state updates, including pin and visibility flags
      console.log('[MapScreen | handleLocationMarkerPress] --- Restoring ALL state updates ---');
      setSelectedLocation({ // <-- Keep This Enabled
        name: location.name, 
        geohash: locationGeohash, 
        coordinates: { latitude: location.latitude, longitude: location.longitude },
        isNearBorder: true, // TODO: Update
        alternatives: [] // TODO: Update
      });
      
      // REMOVE the zoom guard - always try to set the cell for markers too
      // if (zoomLevel >= ZOOM_THRESHOLDS.GRID_FADE_IN) { 
          // Restore REAL cell state updates (NO DELAY)
          if (selectedBounds && typeof selectedBounds.sw[1] === 'number' && typeof selectedBounds.sw[0] === 'number' && typeof selectedBounds.ne[1] === 'number' && typeof selectedBounds.ne[0] === 'number') {
            const coords = [
              { latitude: selectedBounds.sw[1], longitude: selectedBounds.sw[0] },
              { latitude: selectedBounds.ne[1], longitude: selectedBounds.sw[0] },
              { latitude: selectedBounds.ne[1], longitude: selectedBounds.ne[0] },
              { latitude: selectedBounds.sw[1], longitude: selectedBounds.ne[0] },
              { latitude: selectedBounds.sw[1], longitude: selectedBounds.sw[0] } 
            ];
            console.log('[MapScreen | handleLocationMarkerPress] Setting REAL cell coords:', JSON.stringify(coords)); // Removed 'Zoom OK' tag
            setSelectedCellCoords(coords);
            if (!firstClickHandled) {
              // console.log('[MapScreen | handleLocationMarkerPress] Setting firstClickHandled to true'); // Remove log
              setFirstClickHandled(true); // <-- Restore first click flag
            }
          } else {
            console.warn('[MapScreen | handleLocationMarkerPress] Invalid bounds, clearing cell coords', locationGeohash); // Removed 'Zoom OK' tag
            setSelectedCellCoords(null);
          }
      /* // Remove the corresponding else block for the zoom guard
      } else {
            console.log(`[MapScreen | handleLocationMarkerPress] Zoom (${zoomLevel}) too low, NOT setting cell coords.`);
            // Optionally clear coords if zoom is too low, although useEffect might handle this
            // setSelectedCellCoords(null);
      }
      */

      // Hide the general violet selection pin/coords when clicking a blue marker
      console.log('[MapScreen | handleLocationMarkerPress] Clearing selectionCoords and hiding pin');
      setSelectionCoords(null); // Keep this null for marker press
      setSelectionPinVisible(false); // <-- Restore visibility flag (set to false for marker press)
      
      // console.log('[MapScreen | handleLocationMarkerPress] Exiting successfully (All states updated)'); // Remove verbose log

    } catch (error) {
      console.error('[MapScreen | handleLocationMarkerPress] CRITICAL ERROR:', error);
       if (error instanceof Error) {
           console.error(`[MapScreen | handleLocationMarkerPress] Error details: ${error.message} ${error.stack}`);
       }
    }
  };

  // Create themed styles
  const styles = useMemo(() => StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: 'transparent', // Make container transparent
      // Ensure content renders behind the status bar
      paddingTop: 0,
      marginTop: 0,
    },
    map: {
      flex: 1,
      // Make map extend to edges
      position: 'absolute',
      top: 0, // Reset top to 0 to fill screen
      left: 0,
      right: 0,
      bottom: 0,
    },
    webView: {
      flex: 1,
      backgroundColor: 'transparent', // Crucial for overlay
    },
    webViewContainer: {
       ...StyleSheet.absoluteFillObject,
       zIndex: 1, // WebView sits between map (implicit 0) and UI controls
       pointerEvents: 'none', // Apply pointerEvents to the container
    },
    myLocationButton: {
      position: 'absolute',
      right: theme.spacing.md,
      bottom: 160, // Position above layer toggle
      width: 48,
      height: 48,
      borderRadius: 24,
      backgroundColor: theme.colors.card,
      justifyContent: 'center',
      alignItems: 'center',
      // Apply theme-based shadows
      ...theme.shadows.medium,
      // Add subtle border for definition
      borderWidth: Platform.OS === 'ios' ? 0.5 : 0,
      borderColor: theme.colors.border,
    },
    loadingContainer: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      justifyContent: 'center',
      alignItems: 'center',
      backgroundColor: theme.isDark ? 'rgba(0,0,0,0.7)' : 'rgba(255,255,255,0.7)',
      zIndex: 1000,
    },
    errorContainer: {
      position: 'absolute',
      top: '50%',
      left: 20,
      right: 20,
      padding: theme.spacing.md,
      backgroundColor: `${theme.colors.error}CC`, // 80% opacity
      borderRadius: theme.borderRadius.md,
      zIndex: 1000,
    },
    errorText: {
      color: theme.colors.white,
      textAlign: 'center',
      fontWeight: 'bold',
      fontSize: theme.typography.fontSize.md,
    },
  }), [theme]);

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="light" translucent backgroundColor="transparent" />
      
      {/* Map View should be rendered first to act as the base layer */}
      <MapView
        ref={mapRef}
        style={styles.map}
        // Only use Google provider on Android to avoid iOS issues
        provider={Platform.OS === 'android' ? PROVIDER_GOOGLE : undefined}
        // Use mapType satellite for both platforms
        mapType={mapType === MapLayerType.SATELLITE ? 'satellite' : 'standard'}
        initialRegion={INITIAL_REGION}
        onRegionChange={handleRegionChange}
        onRegionChangeComplete={handleRegionChangeComplete}
        onPress={handleMapPress}
        showsUserLocation={true} // Enable native blue dot
        showsMyLocationButton={false}
        followsUserLocation={false} // Disable auto-centering on location to allow free panning
        showsCompass={false}
        showsScale={false}
        rotateEnabled={true}
        scrollEnabled={true}
        zoomEnabled={true}
        loadingEnabled={true}
        loadingIndicatorColor={theme.colors.primary}
        onMapReady={handleMapReady}
      >
        {/* Conditionally render UrlTile overlay */}
        {gridTileUrlTemplate && (
           <UrlTile
             key={gridTileUrlTemplate} // Add key to force re-render on URL change
             urlTemplate={gridTileUrlTemplate}
             zIndex={1} // Ensure grid is above basemap, below markers/UI
             tileSize={256}
             shouldReplaceMapContent={false} // Keep the base map visible
             minimumZ={17} // Synced with server's MIN_GRID_ZOOM setting
             maximumZ={22} // Hide grid beyond zoom level 22 (adjust as needed)
             opacity={0.7} // Restore opacity for fade effect
          />
        )}
        
        {/* Selected Cell Highlight */}
        {(() => { // Keep IIFE wrapper for potential future use
          // Remove log from render path
          /*
          if (selectedCellCoords) {
             console.log('[MapScreen | Render] Attempting to render Polygon with coords:', JSON.stringify(selectedCellCoords));
          } else {
             console.log('[MapScreen | Render] selectedCellCoords is null, not rendering Polygon.');
          }
          */
          return selectedCellCoords && (
            <Polygon
              coordinates={selectedCellCoords}
              fillColor={`${theme.colors.primary}33`} // 20% opacity using hex
              strokeColor={theme.colors.primary} // Full opacity stroke
              strokeWidth={1} // <-- Increase stroke width slightly
              zIndex={2}
            />
          );
        })()}
        
        {/* Selection Marker (Violet Pin) */}
        {(selectionCoords && selectionPinVisible && (firstClickHandled || selectionCoords)) && (
          <Marker
            coordinate={selectionCoords}
            pinColor={PIN.COLOR}
            tracksViewChanges={false}
            zIndex={3}
            anchor={{ x: 0.5, y: 1.0 }}
          />
        )}
        
        {/* Render markers for fetched locations - RESTORE THIS */} 
        {locations.map((location) => {
          if (typeof location?.latitude !== 'number' || typeof location?.longitude !== 'number') {
            console.warn(`Skipping rendering marker for location ID: ${location.id} due to invalid coordinates`);
            return null;
          }
          
          return (
            <Marker
              key={location.id}
              coordinate={{ latitude: location.latitude, longitude: location.longitude }}
              pinColor="blue"
              tracksViewChanges={false} 
              zIndex={4} 
              onPress={(e) => {
                // Prevent map press event when clicking marker
                e.stopPropagation(); 
                handleLocationMarkerPress(location);
              }}
            />
          );
        })}
      </MapView>

      {/* SearchHeader - positioned at top with proper spacing */}
      <SearchHeader 
        onSearchPress={handleSearchPress}
        onSearchQueryChange={handleSearchQueryChange}
        onSearchCancel={handleSearchCancel}
        onProfilePress={handleProfilePress}
        placeholder="Search here"
        isSearchActive={isSearchActive}
        searchQuery={searchQuery}
        showProfile={true}
        showSearch={true}
        avatarUrl={user?.avatarUrl}
        initials={getHeaderInitials()}
        transparent={true}
      />
      
      {/* Show loading indicator while map is loading */}
      {(isLoading && !mapReady) && (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      )}
      
      {/* Show error message if map failed to load */}
      {mapError && (
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>Map could not be loaded: {mapError}</Text>
        </View>
      )}
      
      {/* WebView Overlay - RENDERED ON TOP */}
      {/* {mapReady && (
        <WebView
          ref={webViewRef}
          // source={{ html: inlineHtml }} // Use inline HTML for now - REMOVED
          source={webViewHtmlSource} // Load from required file
          originWhitelist={['*']} // Allow all origins for now
          style={styles.webView}
          containerStyle={styles.webViewContainer}
          javaScriptEnabled={true}
          domStorageEnabled={true}
          onLoadEnd={handleWebViewLoad}
          onMessage={handleWebViewMessage} // Use updated message handler
          webviewDebuggingEnabled={true} // Enable debugging
          // Allows interactions to pass through to the map below
          pointerEvents="none" 
        />
      )} */}
      
      {/* Search Results */}
      <SearchResults
        visible={isSearchActive}
        query={searchQuery}
        results={searchResults}
        recentSearches={recentSearches}
        favorites={favorites}
        onResultPress={handleSearchResultPress}
      />
      
      {/* Layer Toggle */}
      <LayerToggle
        currentLayer={mapType}
        onToggle={toggleMapType}
      />
      
      {/* My Location Button (mobile) */}
      {isMobile && (
        <TouchableOpacity 
          style={styles.myLocationButton}
          onPress={moveToCurrentLocation}
          activeOpacity={0.7}
        >
          <Ionicons name="locate" size={24} color={theme.colors.primary} />
        </TouchableOpacity>
      )}
      
      {/* Location Details - Fix prop name */}
      <LocationDetails 
        locationName={selectedLocation.name} // Use name if available
        locationGeohash={selectedLocation.geohash} // Pass geohash
        coordinates={selectedLocation.coordinates}
        isNearBorder={selectedLocation.isNearBorder}
        alternatives={selectedLocation.alternatives}
      />
    </SafeAreaView>
  );
};

export default MapScreen; 