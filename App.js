import { StatusBar } from 'expo-status-bar';
import { StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { Asset } from 'expo-asset';
// SDK 54+ moved the classic file API (readAsStringAsync) to the /legacy subpath.
import * as FileSystem from 'expo-file-system/legacy';
import { useEffect, useState } from 'react';

export default function App() {
  const [html, setHtml] = useState(null);

  useEffect(() => {
    (async () => {
      const asset = Asset.fromModule(require('./assets/app.html'));
      await asset.downloadAsync();
      const content = await FileSystem.readAsStringAsync(asset.localUri);
      setHtml(content);
    })();
  }, []);

  return (
    <View style={styles.container}>
      <StatusBar style="light" backgroundColor="#0c0f14" translucent={false} />
      {html && (
        <WebView
          style={styles.webview}
          source={{ html }}
          originWhitelist={['*']}
          javaScriptEnabled={true}
          domStorageEnabled={true}
          allowFileAccess={true}
          mixedContentMode="always"
          scrollEnabled={true}
          bounces={false}
          overScrollMode="never"
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0c0f14',
  },
  webview: {
    flex: 1,
    backgroundColor: '#0c0f14',
  },
});
