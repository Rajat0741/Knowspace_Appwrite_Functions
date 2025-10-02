import ImageKit from 'imagekit';

/**
 * Combined Appwrite Function for ImageKit operations
 * Handles both authentication (for uploads) and file deletion
 * 
 * Operations:
 * - auth: Generate authentication parameters for client-side uploads
 * - delete: Delete a file from ImageKit storage
 */
export default async ({ req, res, log, error }) => {
  try {
    // Parse request body
    const body = JSON.parse(req.bodyText || '{}');
    const { operation, fileId } = body;

    // Get ImageKit credentials from environment variables
    const publicKey = process.env.IMAGEKIT_PUBLIC_KEY;
    const privateKey = process.env.IMAGEKIT_PRIVATE_KEY;
    const urlEndpoint = process.env.IMAGEKIT_URL_ENDPOINT;

    if (!publicKey || !privateKey || !urlEndpoint) {
      error('ImageKit credentials not configured in environment variables');
      return res.json({
        success: false,
        error: 'ImageKit credentials not configured'
      }, 500);
    }

    // Initialize ImageKit
    const imagekit = new ImageKit({
      publicKey: publicKey,
      privateKey: privateKey,
      urlEndpoint: urlEndpoint
    });

    // Handle different operations
    switch (operation) {
      case 'auth':
        // Generate authentication parameters for uploads
        log('Generating authentication parameters');
        const authParams = imagekit.getAuthenticationParameters();
        
        return res.json({
          success: true,
          operation: 'auth',
          token: authParams.token,
          expire: authParams.expire,
          signature: authParams.signature
        }, 200);

      case 'delete':
        // Delete file from ImageKit
        if (!fileId) {
          error('fileId is required for delete operation');
          return res.json({
            success: false,
            error: 'fileId is required for delete operation'
          }, 400);
        }

        log(`Deleting file: ${fileId}`);
        await imagekit.deleteFile(fileId);
        
        log(`File deleted successfully: ${fileId}`);
        return res.json({
          success: true,
          operation: 'delete',
          message: 'File deleted successfully',
          fileId: fileId
        }, 200);

      default:
        error(`Unknown operation: ${operation}`);
        return res.json({
          success: false,
          error: `Unknown operation: ${operation}. Valid operations are: auth, delete`
        }, 400);
    }
  } catch (err) {
    error(`Error processing request: ${err.message}`);
    return res.json({
      success: false,
      error: err.message
    }, 500);
  }
};
